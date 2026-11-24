// Gated exec for POSIX provider CLIs. This pid is a small parent that forks the leader, reports the
// leader's wait status on fd 6 and reaps it; on Linux it is a subreaper that reaps the watcher and
// adopted descendants until leader and watcher are gone, then exits and leaves live descendants to
// the next reaper. The leader starts its own session, forks the same-session owner-pipe
// watcher, reports both on fd 5, waits for the owner's GO on fd 4, then execs the CLI with its argv,
// environment, signal mask and dispositions unchanged.
// Usage: orca-provider-exec --cli-input-fd7 <stdinEndGraceMs> <sigtermGraceMs> <session|one-shot>
//          <stdin-end|stdin-end-and-sigterm> -- <command> [args...]
// The fixed --cli-input-fd7 prefix identifies the private input protocol.
// Linux also: orca-provider-exec --exec-without-inherited-fds -- <command> [args...] execs in place
// keeping only fds 0-2 and NODE_CHANNEL_FD, so a durable child can't hold the launcher's sockets.
#if !defined(__APPLE__)
#define _POSIX_C_SOURCE 200809L
#endif
#if defined(__linux__)
#define _DEFAULT_SOURCE
// glibc before 2.19 declares syscall() only under the older name.
#define _BSD_SOURCE
#endif

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#if defined(__linux__)
#include <dirent.h>
#include <limits.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#endif
#if defined(__APPLE__)
#include <libproc.h>
#include <limits.h>
#include <mach/mach.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
// Newer than the deployment target; where it is missing no detached tool is ever signalled.
extern int proc_signal_with_audittoken(audit_token_t *audittoken, int sig) __attribute__((weak_import));
#endif

enum { OWNER_FD = 3, GATE_FD = 4, STATUS_FD = 5, OUTCOME_FD = 6, INPUT_FD = 7 };
enum {
    EXIT_USAGE = 64,
    EXIT_GATE_CLOSED = 69,
    EXIT_NO_SUBREAPER = 70,
    EXIT_BOOTSTRAP = 71,
    EXIT_OUTCOME_LOST = 74,
    EXIT_EXEC_FAILED = 127,
};
enum { STDIN_END_GRACE_MAX_MS = 1000, SIGTERM_GRACE_MAX_MS = 3000 };

static const int STOP_SIGNALS[] = {SIGTERM, SIGINT, SIGHUP};
enum { STOP_SIGNAL_COUNT = sizeof STOP_SIGNALS / sizeof STOP_SIGNALS[0] };

static volatile sig_atomic_t stop_signal = 0;
static struct sigaction saved_stop_actions[STOP_SIGNAL_COUNT];
static struct sigaction saved_pipe_action;
static struct sigaction saved_child_action;
static sigset_t saved_mask;
static sigset_t stop_set;
static pid_t watcher_pid = -1;
#if defined(__linux__)
// The parent's read end; only the leader before exec and the watcher hold the write end.
static int watcher_gone_fd = -1;
#endif

static void on_stop_signal(int signal_number) { stop_signal = signal_number; }

static int write_all(int fd, const char *data, size_t length) {
    while (length > 0) {
        ssize_t written = write(fd, data, length);
        if (written < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        data += written;
        length -= (size_t)written;
    }
    return 0;
}

#if defined(__APPLE__)
// Independent of the app's addon worker pool; preserves the same exact kernel birth marker.
static int print_process_row(const char *text) {
    if (text[0] < '1' || text[0] > '9') {
        return EXIT_USAGE;
    }
    char *end;
    errno = 0;
    long value = strtol(text, &end, 10);
    if (errno != 0 || *end != '\0' || value > INT_MAX) {
        return EXIT_USAGE;
    }
    pid_t pid = (pid_t)value;
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
    struct kinfo_proc row;
    size_t size = sizeof row;
    if (sysctl(mib, 4, &row, &size, NULL, 0) != 0) {
        return EXIT_BOOTSTRAP;
    }
    if (size == 0) {
        return write_all(1, "absent\n", 7) == 0 ? 0 : EXIT_BOOTSTRAP;
    }
    if (size != sizeof row || row.kp_proc.p_pid != pid) {
        return EXIT_BOOTSTRAP;
    }
    char frame[128];
    int length = snprintf(frame, sizeof frame, "%ld %ld %ld %lld %lld\n", (long)pid,
                          (long)row.kp_eproc.e_ppid, (long)row.kp_eproc.e_pgid,
                          (long long)row.kp_proc.p_starttime.tv_sec,
                          (long long)row.kp_proc.p_starttime.tv_usec);
    return length > 0 && (size_t)length < sizeof frame &&
                   write_all(1, frame, (size_t)length) == 0
               ? 0
               : EXIT_BOOTSTRAP;
}
#endif

// Strict decimal: no sign, whitespace or leading zero, and never above `max`.
static int parse_ms(const char *text, unsigned max, unsigned *out) {
    unsigned value = 0;
    if (text[0] == '\0' || (text[0] == '0' && text[1] != '\0')) {
        return -1;
    }
    for (const char *c = text; *c != '\0'; c++) {
        if (*c < '0' || *c > '9') {
            return -1;
        }
        unsigned digit = (unsigned)(*c - '0');
        // Checked before multiplying so a long input can't wrap back under `max`.
        if (value > (max - digit) / 10) {
            return -1;
        }
        value = value * 10 + digit;
    }
    *out = value;
    return 0;
}

static int set_cloexec(int fd, int enabled) {
    int flags = fcntl(fd, F_GETFD);
    if (flags < 0) {
        return -1;
    }
    flags = enabled ? flags | FD_CLOEXEC : flags & ~FD_CLOEXEC;
    return fcntl(fd, F_SETFD, flags);
}

#if defined(__linux__)
#ifndef CLOSE_RANGE_CLOEXEC
#define CLOSE_RANGE_CLOEXEC (1U << 2)
#endif
// Older glibc headers lack SYS_close_range even when the kernel headers have the number.
#if !defined(SYS_close_range) && defined(__NR_close_range)
#define SYS_close_range __NR_close_range
#endif

// Marks every fd above 2 close-on-exec; walks /proc where close_range is missing or filtered.
static int cloexec_inherited_fds(void) {
#if defined(SYS_close_range)
    if (syscall(SYS_close_range, 3U, ~0U, CLOSE_RANGE_CLOEXEC) == 0) {
        return 0;
    }
    if (errno != ENOSYS && errno != EINVAL && errno != EPERM) {
        return -1;
    }
#endif
    DIR *dir = opendir("/proc/self/fd");
    if (dir == NULL) {
        return -1;
    }
    int failed = 0;
    struct dirent *entry;
    // readdir returns NULL for both the end and an error; only errno tells them apart.
    for (errno = 0; (entry = readdir(dir)) != NULL; errno = 0) {
        unsigned fd;
        if (parse_ms(entry->d_name, INT_MAX, &fd) == 0 && fd > 2 && (int)fd != dirfd(dir) &&
                set_cloexec((int)fd, 1) != 0 && errno != EBADF) {
            failed = 1;
        }
    }
    if (errno != 0) {
        failed = 1;
    }
    closedir(dir);
    return failed ? -1 : 0;
}

// Fails closed: an unproven cleanup or a malformed NODE_CHANNEL_FD never execs.
static int exec_without_inherited_fds(char *argv[]) {
    const char *channel = getenv("NODE_CHANNEL_FD");
    unsigned channel_fd = 0;
    if (channel != NULL &&
            (parse_ms(channel, INT_MAX, &channel_fd) != 0 || channel_fd < 3 ||
                fcntl((int)channel_fd, F_GETFD) < 0)) {
        fputs("orca-provider-exec: NODE_CHANNEL_FD is not an open descriptor\n", stderr);
        return EXIT_USAGE;
    }
    if (cloexec_inherited_fds() != 0 ||
            (channel != NULL && set_cloexec((int)channel_fd, 0) != 0)) {
        fputs("orca-provider-exec: could not close inherited descriptors\n", stderr);
        return EXIT_BOOTSTRAP;
    }
    execvp(argv[0], argv);
    fprintf(stderr, "orca-provider-exec: exec %s failed: %s\n", argv[0], strerror(errno));
    return EXIT_EXEC_FAILED;
}
#endif

static void reap_watcher(void) {
    if (watcher_pid <= 0) {
        return;
    }
    kill(watcher_pid, SIGKILL);
    while (waitpid(watcher_pid, NULL, 0) < 0 && errno == EINTR) {
    }
    watcher_pid = -1;
}

// Never leaves a watcher behind; a stop signal that arrived during bootstrap still ends this pid.
static _Noreturn void fail(int code) {
    reap_watcher();
    int signal_number = stop_signal;
    if (signal_number != 0) {
        sigset_t raised;
        sigemptyset(&raised);
        sigaddset(&raised, signal_number);
        signal(signal_number, SIG_DFL);
        sigprocmask(SIG_UNBLOCK, &raised, NULL);
        raise(signal_number);
    }
    _exit(code);
}

// The watcher reserves the CLI session ID from its own group and holds the owner pipe (fd 3).
// Commands there are stdin-end, term and reap; EOF there is owner death. One phase and absolute
// deadline own the stop, so owner EOF resumes it and a repeated term never restarts or shortens it.
enum watcher_phase { WATCH_IDLE, WATCH_STDIN_GRACE, WATCH_TERM_GRACE, WATCH_REAP };
enum { WATCH_LINE_MAX = 32, WATCH_READ_MAX = 256, WATCH_POLL_MS = 25, WATCH_REAP_MS = 1500 };
enum { TREE_SWEEP_INTERVAL_MS = 100, TREE_SWEEP_MAX_INTERVAL_MS = 1000 };
// A sweep result: the tree can't be proven empty on this host at all (no pidfd or audit-token
// signal, a gone or replaced subreaper, a foreign /proc), so once the CLI group is gone the stop
// ends unverified at once rather than waiting out its deadlines.
enum { TREE_UNPROVABLE = -2 };
// reaper_start before it is known: never provable, or not read yet (a startup read failed).
enum { REAPER_UNPROVEN = -1, REAPER_START_UNREAD = -2 };
// Inherited by every tool the CLI starts, so one reparented to launchd is still found on macOS.
#define TREE_TAG_NAME "ORCA_PROVIDER_TREE"

// Exact process identities kept sorted, so each lookup is a binary search.
struct identity {
    pid_t pid;
    long long start;
    int value;
};

// Lookups see the sorted prefix; items appended past it join on the next settle.
struct identity_set {
    struct identity *items;
    size_t count;
    size_t sorted;
    size_t capacity;
};

struct watcher {
    pid_t group;
    pid_t reaper;
    long long reaper_start;
    int reaper_fd;
    long long leader_start;
    char tree_tag[64];
    long long next_sweep_ns;
    int swept_group_gone;
    // Exact identities already sent TERM, so each gets it once and none is skipped.
    struct identity_set termed;
    // Identities read in full without the tag, so each unrelated orphan is read once per stop.
    struct identity_set untagged;
    // Every member proven during this stop that may still be alive, kept by exact identity.
    struct identity_set known;
    int sweep_generation;
    long long next_full_ns;
    long long sweep_interval_ms;
    int group_term_pending;
    unsigned stdin_end_grace_ms;
    unsigned sigterm_grace_ms;
    int session;
    int close_stdin_end;
    enum watcher_phase phase;
    long long deadline_ns;
    char line[WATCH_LINE_MAX];
    size_t line_length;
    int discarding;
};

static _Noreturn void watcher_complete(int absent) {
    const char *completion = absent ? "group-absent\n" : "group-unverifiable\n";
    write_all(OWNER_FD, completion, strlen(completion));
    _exit(absent ? 0 : EXIT_BOOTSTRAP);
}

static int group_absent(struct watcher *w) {
    return kill(-w->group, 0) < 0 && errno == ESRCH;
}

static int compare_identity(pid_t pid, long long start, const struct identity *item) {
    if (pid != item->pid) {
        return pid < item->pid ? -1 : 1;
    }
    return (start > item->start) - (start < item->start);
}

// Index of the first item not below (pid, start).
static size_t identity_position(const struct identity_set *set, pid_t pid, long long start) {
    size_t low = 0;
    size_t high = set->sorted;
    while (low < high) {
        size_t middle = low + (high - low) / 2;
        if (compare_identity(pid, start, &set->items[middle]) > 0) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

static struct identity *identity_find(const struct identity_set *set, pid_t pid, long long start) {
    size_t at = identity_position(set, pid, start);
    return at < set->sorted && compare_identity(pid, start, &set->items[at]) == 0 ? &set->items[at]
                                                                                     : NULL;
}

static int identity_reserve(struct identity_set *set) {
    if (set->count == set->capacity) {
        size_t capacity = set->capacity > 0 ? set->capacity * 2 : 16;
        void *grown = realloc(set->items, capacity * sizeof *set->items);
        if (grown == NULL) {
            return 0;
        }
        set->items = grown;
        set->capacity = capacity;
    }
    return 1;
}

// Callers reserve first; an identity already present is left as it is.
static void identity_insert(struct identity_set *set, pid_t pid, long long start, int value) {
    size_t at = identity_position(set, pid, start);
    if (at < set->count && compare_identity(pid, start, &set->items[at]) == 0) {
        return;
    }
    memmove(&set->items[at + 1], &set->items[at], (set->count - at) * sizeof *set->items);
    set->items[at] = (struct identity){.pid = pid, .start = start, .value = value};
    set->count++;
    set->sorted = set->count;
}

#if defined(__APPLE__)
static int compare_identities(const void *a, const void *b) {
    const struct identity *right = b;
    return compare_identity(((const struct identity *)a)->pid, ((const struct identity *)a)->start,
        right);
}

// Batched inserts, so identities arriving out of order cost one sort rather than a shift each.
static void identity_append(struct identity_set *set, pid_t pid, long long start) {
    set->items[set->count++] = (struct identity){.pid = pid, .start = start};
}

static void identity_settle(struct identity_set *set) {
    if (set->sorted == set->count) {
        return;
    }
    qsort(set->items, set->count, sizeof *set->items, compare_identities);
    size_t kept = 0;
    for (size_t i = 0; i < set->count; i++) {
        if (kept == 0 || compare_identities(&set->items[kept - 1], &set->items[i]) != 0) {
            set->items[kept++] = set->items[i];
        }
    }
    set->count = kept;
    set->sorted = kept;
}
#endif

struct proc_row {
    pid_t pid;
    pid_t ppid;
    pid_t pgid;
    uid_t uid;
    long long start;
    int zombie;
    int stale;
};

#if defined(__APPLE__)
static long long kinfo_start(const struct kinfo_proc *k) {
    return (long long)k->kp_proc.p_starttime.tv_sec * 1000000LL +
           (long long)k->kp_proc.p_starttime.tv_usec;
}

// Attaching a debugger reparents its target to it, and the PID it was born to is kept aside but
// never updated. That PID is the parent only while it holds a process no younger than the target;
// otherwise the parent is gone and the target counts as launchd's, as a detach would make it.
static pid_t traced_parent(const struct kinfo_proc *k) {
    pid_t birth = k->kp_proc.p_oppid;
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, birth};
    struct kinfo_proc parent;
    size_t size = sizeof parent;
    if (birth > 1 && sysctl(mib, 4, &parent, &size, NULL, 0) == 0 && size == sizeof parent &&
            parent.kp_proc.p_pid == birth && parent.kp_proc.p_stat != SZOMB &&
            kinfo_start(&parent) <= kinfo_start(k)) {
        return birth;
    }
    return 1;
}

static void row_from_kinfo(const struct kinfo_proc *k, struct proc_row *row) {
    row->pid = k->kp_proc.p_pid;
    row->ppid = k->kp_proc.p_flag & P_TRACED ? traced_parent(k) : k->kp_eproc.e_ppid;
    row->pgid = k->kp_eproc.e_pgid;
    row->uid = k->kp_eproc.e_ucred.cr_uid;
    row->start = kinfo_start(k);
    row->zombie = k->kp_proc.p_stat == SZOMB;
    row->stale = 0;
}

static int read_row(pid_t pid, struct proc_row *row) {
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
    struct kinfo_proc k;
    size_t size = sizeof k;
    if (sysctl(mib, 4, &k, &size, NULL, 0) != 0) {
        return -1;
    }
    if (size == 0) {
        return 0;
    }
    if (size != sizeof k || k.kp_proc.p_pid != pid) {
        return -1;
    }
    row_from_kinfo(&k, row);
    return 1;
}

static struct proc_row *read_table(size_t *count) {
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
    for (int attempt = 0; attempt < 4; attempt++) {
        size_t size = 0;
        if (sysctl(mib, 4, NULL, &size, NULL, 0) != 0) {
            return NULL;
        }
        size += size / 4 + sizeof(struct kinfo_proc) * 16;
        struct kinfo_proc *procs = malloc(size);
        if (procs == NULL) {
            return NULL;
        }
        if (sysctl(mib, 4, procs, &size, NULL, 0) != 0) {
            free(procs);
            if (errno == ENOMEM) {
                continue;
            }
            return NULL;
        }
        size_t n = size / sizeof *procs;
        struct proc_row *rows = malloc((n > 0 ? n : 1) * sizeof *rows);
        if (rows != NULL) {
            for (size_t i = 0; i < n; i++) {
                row_from_kinfo(&procs[i], &rows[i]);
            }
            *count = n;
        }
        free(procs);
        return rows;
    }
    return NULL;
}

// 1 tagged, 0 read in full without the tag, -1 unreadable right now.
// Reads the environment the process was exec'd with; unreadable means not provably ours.
static int carries_tree_tag(pid_t pid, const char *tag) {
    static char *args;
    static size_t args_max;
    if (args == NULL) {
        int max_mib[] = {CTL_KERN, KERN_ARGMAX};
        int max = 0;
        size_t max_size = sizeof max;
        if (sysctl(max_mib, 2, &max, &max_size, NULL, 0) != 0 || max <= 0 ||
                (args = malloc((size_t)max)) == NULL) {
            return -1;
        }
        args_max = (size_t)max;
    }
    int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
    size_t size = args_max;
    if (sysctl(mib, 3, args, &size, NULL, 0) != 0 || size < sizeof(int)) {
        return -1;
    }
    int argc;
    memcpy(&argc, args, sizeof argc);
    // Only environment entries count. An empty argv[0] merges into the exec path's padding, which
    // can only hide a tag (a miss), never admit one.
    const char *p = memchr(args + sizeof argc, '\0', size - sizeof argc);
    const char *end = args + size;
    while (p != NULL && p < end && *p == '\0') {
        p++;
    }
    size_t tag_length = strlen(tag);
    for (int i = 0; p != NULL && p < end && (i < argc || *p != '\0'); i++) {
        const char *z = memchr(p, '\0', (size_t)(end - p));
        if (z == NULL) {
            return -1;
        }
        if (i >= argc && (size_t)(z - p) == tag_length && memcmp(p, tag, tag_length) == 0) {
            return 1;
        }
        p = z + 1;
    }
    return 0;
}
#elif defined(__linux__)
static int read_row(pid_t pid, struct proc_row *row) {
    char path[32];
    snprintf(path, sizeof path, "/proc/%ld/stat", (long)pid);
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        if (errno == EACCES || errno == EPERM) {
            // hidepid hides other users' rows, which the watcher can't signal; a hidden row it can
            // signal (a same-user tool that is not dumpable) could be a member, so it is reported.
            return kill(pid, 0) == 0 ? 2 : 0;
        }
        return errno == ENOENT || errno == ESRCH ? 0 : -1;
    }
    char buf[1024];
    ssize_t got;
    while ((got = read(fd, buf, sizeof buf - 1)) < 0 && errno == EINTR) {
    }
    int read_errno = errno;
    close(fd);
    if (got <= 0) {
        return got == 0 || read_errno == ESRCH ? 0 : -1;
    }
    buf[got] = '\0';
    // comm may hold spaces or parens; the fields after the last ')' are fixed.
    const char *fields = strrchr(buf, ')');
    char state;
    int ppid;
    int pgid;
    long threads;
    unsigned long long start;
    if (fields == NULL ||
            sscanf(fields + 1,
                " %c %d %d %*d %*d %*d %*u %*u %*u %*u %*u %*u %*u %*d %*d %*d %*d %ld %*d %llu",
                &state, &ppid, &pgid, &threads, &start) != 5) {
        return -1;
    }
    row->pid = pid;
    row->ppid = ppid;
    row->pgid = pgid;
    row->uid = 0;
    row->start = (long long)start;
    // A main thread that called pthread_exit shows Z while its other threads still run.
    row->zombie = (state == 'Z' || state == 'X') && threads <= 1;
    row->stale = 0;
    return 1;
}

// NSpid lists this process's PID in the procfs mount's namespace and each nested one, so a single
// entry equal to getpid() proves /proc describes this namespace.
// 1 this namespace, 0 another one (or no NSpid line), -1 unreadable right now.
static int procfs_in_own_namespace(void) {
    FILE *status = fopen("/proc/self/status", "re");
    if (status == NULL) {
        return -1;
    }
    char line[256];
    int own = 0;
    while (fgets(line, sizeof line, status) != NULL) {
        if (strncmp(line, "NSpid:", 6) == 0) {
            char *end;
            long pid = strtol(line + 6, &end, 10);
            while (*end == ' ' || *end == '\t') {
                end++;
            }
            own = end != line + 6 && pid == (long)getpid() && (*end == '\n' || *end == '\0');
            break;
        }
    }
    int failed = ferror(status);
    fclose(status);
    return failed ? -1 : own;
}

// hidepid lets /proc omit or hide processes, a member or its parent among them, so on such a mount
// no scan can prove the tree empty. Unreadable mount info counts as hidden.
static int procfs_hides_processes(void) {
    FILE *mounts = fopen("/proc/self/mountinfo", "re");
    if (mounts == NULL) {
        return 1;
    }
    char line[1024];
    int hidden = 1;
    while (fgets(line, sizeof line, mounts) != NULL) {
        char *fields[5] = {0};
        char *cursor = line;
        for (int i = 0; i < 5 && cursor != NULL; i++) {
            fields[i] = cursor;
            cursor = strchr(cursor, ' ');
            if (cursor != NULL) {
                *cursor++ = '\0';
            }
        }
        char *separator = cursor != NULL ? strstr(cursor, " - ") : NULL;
        if (fields[4] == NULL || strcmp(fields[4], "/proc") != 0 || separator == NULL ||
                strncmp(separator + 3, "proc ", 5) != 0) {
            continue;
        }
        const char *option = strstr(separator, "hidepid=");
        hidden = option != NULL && strncmp(option + 8, "0", 1) != 0 &&
                 strncmp(option + 8, "off", 3) != 0;
    }
    fclose(mounts);
    return hidden;
}

// Set by the last table read when it held a row this watcher could signal but not read.
static int table_has_hidden_row;

static struct proc_row *read_table(size_t *count) {
    table_has_hidden_row = 0;
    DIR *dir = opendir("/proc");
    if (dir == NULL) {
        return NULL;
    }
    size_t n = 0;
    size_t capacity = 256;
    struct proc_row *rows = malloc(capacity * sizeof *rows);
    int failed = rows == NULL;
    struct dirent *entry;
    for (errno = 0; !failed && (entry = readdir(dir)) != NULL; errno = 0) {
        unsigned pid;
        if (parse_ms(entry->d_name, INT_MAX, &pid) != 0) {
            continue;
        }
        if (n == capacity) {
            struct proc_row *grown = realloc(rows, capacity * 2 * sizeof *rows);
            if (grown == NULL) {
                failed = 1;
                break;
            }
            rows = grown;
            capacity *= 2;
        }
        int found = read_row((pid_t)pid, &rows[n]);
        if (found < 0) {
            failed = 1;
        } else if (found == 2) {
            table_has_hidden_row = 1;
        } else if (found > 0) {
            n++;
        }
    }
    if (errno != 0) {
        failed = 1;
    }
    closedir(dir);
    if (failed) {
        free(rows);
        return NULL;
    }
    *count = n;
    return rows;
}

static int compare_pid(const void *a, const void *b) {
    pid_t left = *(const pid_t *)a;
    pid_t right = *(const pid_t *)b;
    return (left > right) - (left < right);
}

static int append_pid(pid_t **pids, size_t *n, size_t *capacity, long pid) {
    if (pid <= 0 || pid > INT_MAX) {
        return -1;
    }
    if (*n == *capacity) {
        size_t grown_capacity = *capacity > 0 ? *capacity * 2 : 64;
        pid_t *grown = realloc(*pids, grown_capacity * sizeof **pids);
        if (grown == NULL) {
            return -1;
        }
        *pids = grown;
        *capacity = grown_capacity;
    }
    (*pids)[(*n)++] = (pid_t)pid;
    return 0;
}

// Appends the children of each of pid's threads. 0 read (or pid gone), 1 a list was hidden,
// -1 failed.
static int append_children(pid_t pid, pid_t **pids, size_t *n, size_t *capacity) {
    char path[64];
    snprintf(path, sizeof path, "/proc/%ld/task", (long)pid);
    DIR *tasks = opendir(path);
    if (tasks == NULL) {
        return errno == ENOENT || errno == ESRCH ? 0 : errno == EACCES || errno == EPERM ? 1 : -1;
    }
    int result = 0;
    struct dirent *entry;
    for (errno = 0; result >= 0 && (entry = readdir(tasks)) != NULL; errno = 0) {
        unsigned tid;
        if (parse_ms(entry->d_name, INT_MAX, &tid) != 0) {
            continue;
        }
        snprintf(path, sizeof path, "/proc/%ld/task/%u/children", (long)pid, tid);
        FILE *children = fopen(path, "re");
        if (children == NULL) {
            if (errno == EACCES || errno == EPERM) {
                result = 1;
            } else if (errno != ENOENT && errno != ESRCH) {
                result = -1;
            }
            continue;
        }
        long child;
        while (result >= 0 && fscanf(children, "%ld", &child) == 1) {
            if (append_pid(pids, n, capacity, child) != 0) {
                result = -1;
            }
        }
        if (ferror(children)) {
            result = -1;
        }
        fclose(children);
    }
    if (result >= 0 && errno != 0) {
        result = -1;
    }
    closedir(tasks);
    return result;
}

// Reads the subreaper and its descendants through each thread's children list, so the cost follows
// the chat's tree rather than the host. A child missed while its parent exits is adopted by the
// subreaper, whose list the absence proof reads. Sets no_lists when the kernel has no such lists.
static struct proc_row *read_tree_table(pid_t reaper, size_t *count, int *no_lists) {
    table_has_hidden_row = 0;
    char path[64];
    snprintf(path, sizeof path, "/proc/%ld/task/%ld/children", (long)reaper, (long)reaper);
    if (access(path, R_OK) != 0) {
        *no_lists = errno == ENOENT;
        return NULL;
    }
    pid_t *pids = NULL;
    size_t n = 0;
    size_t capacity = 0;
    struct proc_row *rows = NULL;
    int failed = append_pid(&pids, &n, &capacity, reaper) != 0;
    // A PID reused mid-walk could list a process twice; the cap bounds any such repetition.
    for (size_t i = 0; !failed && i < n; i++) {
        int got = append_children(pids[i], &pids, &n, &capacity);
        failed = got < 0 || n > (size_t)INT_MAX / 4;
        if (got == 1) {
            table_has_hidden_row = 1;
        }
    }
    if (!failed) {
        qsort(pids, n, sizeof *pids, compare_pid);
        rows = malloc((n > 0 ? n : 1) * sizeof *rows);
        failed = rows == NULL;
    }
    size_t kept = 0;
    for (size_t i = 0; !failed && i < n; i++) {
        if (i > 0 && pids[i] == pids[i - 1]) {
            continue;
        }
        int found = read_row(pids[i], &rows[kept]);
        if (found < 0) {
            failed = 1;
        } else if (found == 2) {
            table_has_hidden_row = 1;
        } else if (found > 0) {
            kept++;
        }
    }
    free(pids);
    if (failed) {
        free(rows);
        return NULL;
    }
    *count = kept;
    return rows;
}
#endif

#if defined(__APPLE__) || defined(__linux__)
static int compare_row_pid(const void *a, const void *b) {
    pid_t left = ((const struct proc_row *)a)->pid;
    pid_t right = ((const struct proc_row *)b)->pid;
    return (left > right) - (left < right);
}

static const struct proc_row *find_row(const struct proc_row *rows, size_t n, pid_t pid) {
    struct proc_row key = {.pid = pid};
    return bsearch(&key, rows, n, sizeof *rows, compare_row_pid);
}

// Tools can setsid away from the CLI group, so its whole tree is read before any signal.
// Linux anchors at the subreaper, which adopts orphans. macOS anchors at the live leader and at
// launchd orphans that carry the tag or share a session with a member: a session holds only
// descendants of the member that created it, and its id is never reissued while it exists.
struct tree_scan {
    struct proc_row *rows;
    size_t n;
    unsigned char *state;
    size_t *chain;
    int leader_alive;
};

#if defined(__APPLE__)
// Only a full read without the tag is cached per identity (most launchd orphans are unrelated).
// A tagged process is read again each sweep, so one that execs without the tag drops out, and a
// failed read is retried.
static int tagged_once(struct watcher *w, const struct proc_row *row) {
    if (identity_find(&w->untagged, row->pid, row->start) != NULL) {
        return 0;
    }
    int tagged = carries_tree_tag(row->pid, w->tree_tag);
    if (tagged == 0 && identity_reserve(&w->untagged)) {
        identity_append(&w->untagged, row->pid, row->start);
    }
    return tagged == 1;
}
#endif

// The row's process still holds that PID, so whatever was read about it since the row is its own.
static int same_identity(const struct proc_row *row) {
    struct proc_row now;
    return read_row(row->pid, &now) == 1 && now.start == row->start && !now.zombie;
}

enum { TREE_UNKNOWN, TREE_ANCESTRY, TREE_OUTSIDE, TREE_TAGGED };

static int tree_member(unsigned char state) {
    return state == TREE_ANCESTRY || state == TREE_TAGGED;
}

#if defined(__linux__)
// Resolved once along each ancestor chain; a row is a member if its chain reaches the subreaper.
// A stale row is neither a member nor a parent.
static int resolve_members(struct watcher *w, struct tree_scan *scan) {
    pid_t self = getpid();
    memset(scan->state, 0, scan->n);
    for (size_t i = 0; i < scan->n; i++) {
        size_t depth = 0;
        size_t at = i;
        unsigned char verdict = TREE_OUTSIDE;
        while (scan->state[at] == TREE_UNKNOWN && depth < scan->n) {
            scan->chain[depth++] = at;
            const struct proc_row *row = &scan->rows[at];
            if (row->stale || row->pid == self || row->pid == w->reaper || row->pid <= 1) {
                break;
            }
            if (row->ppid == w->reaper) {
                verdict = TREE_ANCESTRY;
                break;
            }
            const struct proc_row *parent = find_row(scan->rows, scan->n, row->ppid);
            if (parent == NULL) {
                break;
            }
            at = (size_t)(parent - scan->rows);
        }
        if (scan->state[at] != TREE_UNKNOWN) {
            verdict = scan->state[at];
        }
        for (size_t d = 0; d < depth; d++) {
            scan->state[scan->chain[d]] = verdict;
        }
    }
    return 0;
}
#else
#define NO_TOP SIZE_MAX
#define UNRESOLVED_TOP (SIZE_MAX - 1)

// A launchd orphan that may head part of the tree, keyed by its session.
struct session_root {
    pid_t sid;
    size_t row;
    int opened;
};

struct launchd_tree {
    size_t *top;
    size_t *start;
    size_t *order;
    size_t *queue;
    size_t queued;
    struct session_root *roots;
    size_t root_count;
};

static int compare_session_root(const void *a, const void *b) {
    pid_t left = ((const struct session_root *)a)->sid;
    pid_t right = ((const struct session_root *)b)->sid;
    return (left > right) - (left < right);
}

// A row's top is its nearest ancestor, or itself, that is a child of the live leader or of launchd;
// rows under a top take its kind. Memoised, so the table is walked once.
static size_t row_top(struct watcher *w, struct tree_scan *scan, size_t *top, size_t i) {
    pid_t self = getpid();
    size_t depth = 0;
    size_t at = i;
    size_t found = NO_TOP;
    while (top[at] == UNRESOLVED_TOP && depth < scan->n) {
        scan->chain[depth++] = at;
        const struct proc_row *row = &scan->rows[at];
        if (row->stale || row->pid == self || row->pid == w->reaper || row->pid <= 1) {
            break;
        }
        if ((scan->leader_alive && row->ppid == w->group) || row->ppid == 1) {
            found = at;
            break;
        }
        const struct proc_row *parent = find_row(scan->rows, scan->n, row->ppid);
        if (parent == NULL) {
            break;
        }
        at = (size_t)(parent - scan->rows);
    }
    if (top[at] != UNRESOLVED_TOP) {
        found = top[at];
    }
    for (size_t d = 0; d < depth; d++) {
        top[scan->chain[d]] = found;
    }
    return found;
}

// The first root in sid's run, which carries the run's opened flag, or root_count if there is none.
static size_t session_first(const struct launchd_tree *t, pid_t sid) {
    size_t low = 0;
    size_t high = t->root_count;
    while (low < high) {
        size_t mid = low + (high - low) / 2;
        if (t->roots[mid].sid < sid) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low < t->root_count && t->roots[low].sid == sid ? low : t->root_count;
}

static int session_unopened(const struct launchd_tree *t, pid_t sid) {
    size_t first = session_first(t, sid);
    return first < t->root_count && !t->roots[first].opened;
}

// Admits every launchd orphan in a session a member holds, the first time that session is seen.
// Only a session read between two identity checks of a member is that member's session.
static void open_session(struct tree_scan *scan, struct launchd_tree *t, pid_t sid) {
    size_t low = session_first(t, sid);
    if (low == t->root_count || t->roots[low].opened) {
        return;
    }
    t->roots[low].opened = 1;
    for (size_t k = low; k < t->root_count && t->roots[k].sid == sid; k++) {
        size_t row = t->roots[k].row;
        if (scan->state[row] == TREE_OUTSIDE) {
            // A root that changed identity is left out, as a reused PID proves nothing.
            scan->state[row] = same_identity(&scan->rows[row]) ? TREE_ANCESTRY : TREE_UNKNOWN;
            if (scan->state[row] == TREE_ANCESTRY) {
                t->queue[t->queued++] = row;
            }
        }
    }
}

// Admits rows top by top: the leader's children, then each launchd orphan in a member's session,
// whose members may open further sessions; tops left over are admitted only by the tag or an
// earlier proof, which never vouch for their session. Each row and each session is visited once.
static int resolve_members(struct watcher *w, struct tree_scan *scan) {
    size_t n = scan->n;
    size_t slots = n > 0 ? n : 1;
    struct launchd_tree t = {
        .top = malloc(slots * sizeof *t.top),
        .start = calloc(n + 1, sizeof *t.start),
        .order = malloc(slots * sizeof *t.order),
        .queue = malloc(slots * sizeof *t.queue),
        .roots = malloc(slots * sizeof *t.roots),
    };
    int result = -1;
    if (t.top == NULL || t.start == NULL || t.order == NULL || t.queue == NULL || t.roots == NULL) {
        goto done;
    }
    for (size_t i = 0; i < n; i++) {
        t.top[i] = UNRESOLVED_TOP;
        scan->state[i] = TREE_OUTSIDE;
    }
    for (size_t i = 0; i < n; i++) {
        size_t top = row_top(w, scan, t.top, i);
        if (top != NO_TOP) {
            t.start[top + 1]++;
        }
    }
    for (size_t i = 0; i < n; i++) {
        t.start[i + 1] += t.start[i];
    }
    // order lists each top's rows contiguously; queue serves as the fill cursor until it is used.
    memcpy(t.queue, t.start, n * sizeof *t.queue);
    for (size_t i = 0; i < n; i++) {
        if (t.top[i] != NO_TOP) {
            t.order[t.queue[t.top[i]]++] = i;
        }
    }
    for (size_t i = 0; i < n; i++) {
        const struct proc_row *row = &scan->rows[i];
        if (t.top[i] != i) {
            continue;
        }
        if (scan->leader_alive && row->ppid == w->group) {
            scan->state[i] = TREE_ANCESTRY;
            t.queue[t.queued++] = i;
        } else if (row->uid == geteuid() && row->start >= w->leader_start && !row->zombie) {
            pid_t sid = getsid(row->pid);
            t.roots[t.root_count++] = (struct session_root){.sid = sid > 0 ? sid : 0, .row = i};
        }
    }
    qsort(t.roots, t.root_count, sizeof *t.roots, compare_session_root);
    open_session(scan, &t, w->group);
    for (size_t head = 0; head < t.queued; head++) {
        size_t top = t.queue[head];
        for (size_t k = t.start[top]; k < t.start[top + 1]; k++) {
            size_t i = t.order[k];
            const struct proc_row *row = &scan->rows[i];
            scan->state[i] = TREE_ANCESTRY;
            if (row->zombie) {
                continue;
            }
            pid_t sid = getsid(row->pid);
            if (sid > 0 && session_unopened(&t, sid) && same_identity(row)) {
                open_session(scan, &t, sid);
            }
        }
    }
    for (size_t k = 0; k < t.root_count; k++) {
        size_t top = t.roots[k].row;
        const struct proc_row *row = &scan->rows[top];
        if (scan->state[top] != TREE_OUTSIDE) {
            continue;
        }
        // A member an earlier sweep proved vouches for its later children, though not its session.
        int tagged = identity_find(&w->known, row->pid, row->start) != NULL || tagged_once(w, row);
        if (tagged && same_identity(row)) {
            for (size_t j = t.start[top]; j < t.start[top + 1]; j++) {
                scan->state[t.order[j]] = TREE_TAGGED;
            }
        }
    }
    for (size_t i = 0; i < n; i++) {
        if (scan->state[i] == TREE_UNKNOWN) {
            scan->state[i] = TREE_OUTSIDE;
        }
    }
    identity_settle(&w->untagged);
    result = 0;
done:
    free(t.top);
    free(t.start);
    free(t.order);
    free(t.queue);
    free(t.roots);
    return result;
}
#endif

// Rows are read one by one, so a parent link holds only if both ends are unchanged after every row
// was read; a member whose identity or parent changed is dropped and the tree re-resolved.
static int same_parent_link(const struct proc_row *row) {
    struct proc_row now;
    return read_row(row->pid, &now) == 1 && now.start == row->start && !now.zombie &&
           now.ppid == row->ppid;
}

// A member whose parent changed since its row was read may have been linked through a PID that
// now names another process, so it is dropped until a later sweep reads it afresh.
static int drop_stale_members(struct tree_scan *scan, const struct proc_row *leader) {
    int dropped = 0;
    if (scan->leader_alive && !same_identity(leader)) {
        scan->leader_alive = 0;
        dropped = 1;
    }
    for (size_t i = 0; i < scan->n; i++) {
        if (tree_member(scan->state[i]) && !scan->rows[i].stale &&
                !same_parent_link(&scan->rows[i])) {
            scan->rows[i].stale = 1;
            dropped = 1;
        }
    }
    return dropped;
}

#if defined(__linux__)
// Older glibc headers lack the numbers; both are the same on every architecture Orca builds.
#if !defined(SYS_pidfd_open)
#define SYS_pidfd_open 434
#endif
#if !defined(SYS_pidfd_send_signal)
#define SYS_pidfd_send_signal 424
#endif
#if !defined(CLOCK_BOOTTIME)
#define CLOCK_BOOTTIME 7
#endif
#endif

// Returns whether the member may still be alive. The kernel handle is taken before the start-time
// check, so the signal reaches that process or none: a pidfd on Linux, an audit token (which
// carries the PID version) on macOS. A member whose handle is refused is never signalled, and
// counts as alive unless it is gone.
static int signal_member(struct proc_row *row, int signal_number, int *sent) {
    *sent = 0;
    // A probe needs no signalling handle; the start-time check alone decides liveness.
    if (signal_number == 0) {
        return same_identity(row);
    }
#if defined(__linux__)
    int fd = (int)syscall(SYS_pidfd_open, row->pid, 0);
    if (fd < 0) {
        return errno != ESRCH && same_identity(row);
    }
    int alive = same_identity(row);
    if (alive && signal_number != 0) {
        *sent = syscall(SYS_pidfd_send_signal, fd, signal_number, NULL, 0) == 0;
    }
    close(fd);
    return alive;
#else
    mach_port_t name = MACH_PORT_NULL;
    audit_token_t token;
    mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
    // val[5] is the PID and val[7] its version (audit_token_to_pid without linking libbsm).
    int held = task_name_for_pid(mach_task_self(), row->pid, &name) == KERN_SUCCESS;
    held = held && task_info(name, TASK_AUDIT_TOKEN, (task_info_t)&token, &count) == KERN_SUCCESS &&
           (pid_t)token.val[5] == row->pid;
    if (name != MACH_PORT_NULL) {
        mach_port_deallocate(mach_task_self(), name);
    }
    int alive = same_identity(row);
    if (alive && held && signal_number != 0 && proc_signal_with_audittoken != NULL) {
        *sent = proc_signal_with_audittoken(&token, signal_number) == 0;
    }
    return alive;
#endif
}

static int already_termed(const struct watcher *w, const struct proc_row *row) {
    return identity_find(&w->termed, row->pid, row->start) != NULL;
}

// Room is reserved before a TERM is sent, so a delivered TERM is always recorded.
static int reserve_termed(struct watcher *w) {
    return identity_reserve(&w->termed);
}

static void record_termed(struct watcher *w, const struct proc_row *row) {
    if (!already_termed(w, row) && identity_reserve(&w->termed)) {
        identity_insert(&w->termed, row->pid, row->start, 1);
    }
}

// A member already sent TERM is only probed; one with no room to record it is not sent it, and a
// TERM that wasn't delivered stays due. Returns whether the member is still alive.
static int deliver_to_member(struct watcher *w, struct proc_row *row, int signal_number) {
    int send = signal_number;
    if (signal_number == SIGTERM && (already_termed(w, row) || !reserve_termed(w))) {
        send = 0;
    }
    int sent;
    int alive = signal_member(row, send, &sent);
    if (alive && sent && send == SIGTERM) {
        record_termed(w, row);
    }
    return alive;
}

// Marks a member found by this sweep, so signal_unseen_known skips it.
static void seen_member(struct watcher *w, const struct proc_row *row) {
    struct identity *item = identity_find(&w->known, row->pid, row->start);
    if (item != NULL) {
        item->value = w->sweep_generation;
    }
}

// Only a read that shows the PID gone or reused retires a member; a failed read is doubt.
static int member_gone(const struct proc_row *row) {
    struct proc_row now;
    int read = read_row(row->pid, &now);
    return read == 0 || (read == 1 && (now.start != row->start || now.zombie));
}

// Earlier-proven members this sweep didn't reach: still signalled through their own handle, and
// dropped from the record once gone.
static int signal_unseen_known(struct watcher *w, int signal_number, int *doubt) {
    int live = 0;
    size_t kept = 0;
    for (size_t i = 0; i < w->known.count; i++) {
        struct identity item = w->known.items[i];
        if (item.value != w->sweep_generation) {
            struct proc_row row = {.pid = item.pid, .start = item.start};
            if (deliver_to_member(w, &row, signal_number)) {
                live++;
            } else if (member_gone(&row)) {
                continue;
            } else {
                *doubt = 1;
            }
        }
        w->known.items[kept++] = item;
    }
    w->known.count = kept;
    w->known.sorted = kept;
    return live;
}

// Between full sweeps only the members the last one found are rechecked, each by its own kernel
// handle, so a lingering tool costs O(members) rather than a host-wide table read.
static int probe_known_members(struct watcher *w, int signal_number) {
    int live = 0;
    for (size_t i = 0; i < w->known.count; i++) {
        struct proc_row row = {.pid = w->known.items[i].pid, .start = w->known.items[i].start};
        live += deliver_to_member(w, &row, signal_number);
    }
    return live;
}

#if defined(__linux__)
// Without the subreaper no new member can be proven, but those proven earlier still are the chat's,
// so they keep getting signals through their own handles until they are gone.
static int anchor_lost(struct watcher *w, int signal_number) {
    int live = 0;
    int doubt = 0;
    for (size_t i = 0; i < w->known.count; i++) {
        struct proc_row row = {.pid = w->known.items[i].pid, .start = w->known.items[i].start};
        if (deliver_to_member(w, &row, signal_number)) {
            live++;
        } else if (!member_gone(&row)) {
            doubt = 1;
        }
    }
    return live > 0 ? live : doubt ? -1 : TREE_UNPROVABLE;
}
#endif

// Signals each live descendant once through its kernel handle. Returns how many were alive, or -1
// when the tree could not be read, its anchor is unproven, or a member vanished mid-sweep.
static int sweep_once(struct watcher *w, int signal_number) {
    struct tree_scan scan = {0};
#if defined(__linux__)
    // procfs start times are boot-clock ticks: a row whose tick has not ended before the scan
    // could share it with a replacement at the same PID, so it is left for a later sweep.
    struct timespec boot;
    long ticks_per_second = sysconf(_SC_CLK_TCK);
    if (ticks_per_second <= 0 || clock_gettime(CLOCK_BOOTTIME, &boot) != 0) {
        return -1;
    }
    long long scan_tick = (long long)boot.tv_sec * ticks_per_second +
                          (long long)boot.tv_nsec * ticks_per_second / 1000000000LL;
    // /proc can be remounted while the chat runs, so its namespace is proven around every read.
    int namespace_before = procfs_in_own_namespace();
    if (namespace_before != 1) {
        return namespace_before == 0 ? TREE_UNPROVABLE : -1;
    }
    int hidden_before = procfs_hides_processes();
    struct pollfd anchor = {.fd = w->reaper_fd, .events = POLLIN};
    if (w->reaper_fd < 0 || w->reaper_start == REAPER_UNPROVEN || poll(&anchor, 1, 0) != 0) {
        // The subreaper exited (or its pidfd is unusable), so its PID anchors nothing.
        return anchor_lost(w, signal_number);
    }
    if (w->reaper_start == REAPER_START_UNREAD) {
        // The row is its own only if the pidfd still shows it alive after the read.
        struct proc_row reaper_row;
        if (read_row(w->reaper, &reaper_row) != 1 || poll(&anchor, 1, 0) != 0 ||
                procfs_in_own_namespace() != 1) {
            return -1;
        }
        w->reaper_start = reaper_row.start;
    }
#else
    if (proc_signal_with_audittoken == NULL) {
        return TREE_UNPROVABLE;
    }
#endif
#if defined(__linux__)
    int no_lists = 0;
    scan.rows = read_tree_table(w->reaper, &scan.n, &no_lists);
    if (no_lists) {
        scan.rows = read_table(&scan.n);
    }
#else
    scan.rows = read_table(&scan.n);
#endif
    if (scan.rows == NULL) {
        return -1;
    }
    size_t slots = scan.n > 0 ? scan.n : 1;
    qsort(scan.rows, scan.n, sizeof *scan.rows, compare_row_pid);
    scan.state = malloc(slots);
    scan.chain = malloc(slots * sizeof *scan.chain);
    int live = -1;
    if (scan.state == NULL || scan.chain == NULL) {
        goto done;
    }
#if defined(__linux__)
    // Orphans are adopted by this exact subreaper; any other process at its PID anchors nothing.
    const struct proc_row *reaper = find_row(scan.rows, scan.n, w->reaper);
    // A reaper gone or replaced can't come back; a failed identity read can be retried.
    if (reaper == NULL || reaper->start != w->reaper_start) {
        live = anchor_lost(w, signal_number);
        goto done;
    }
    if (!same_identity(reaper)) {
        goto done;
    }
#endif
    const struct proc_row *leader = find_row(scan.rows, scan.n, w->group);
    scan.leader_alive = leader != NULL && !leader->zombie && leader->start == w->leader_start;
#if defined(__linux__)
    // A hidden row this watcher can signal might be a member, so the scan can't prove absence.
    // Checked around each table read: the mount's options can change while the chat runs.
    int namespace_after = procfs_in_own_namespace();
    if (namespace_after != 1) {
        live = namespace_after == 0 ? TREE_UNPROVABLE : -1;
        goto done;
    }
    int hidden = table_has_hidden_row || hidden_before || procfs_hides_processes();
    int dropped = 0;
#else
    int dropped = 0;
#endif
    for (;;) {
        if (resolve_members(w, &scan) != 0) {
            goto done;
        }
        if (!drop_stale_members(&scan, leader)) {
            break;
        }
        dropped = 1;
    }
    live = 0;
    w->sweep_generation++;
    for (size_t i = 0; i < scan.n; i++) {
        struct proc_row *row = &scan.rows[i];
        if (!tree_member(scan.state[i]) || row->zombie) {
            continue;
        }
        // The CLI group gets its own signal; its TERM counts if a member later leaves the group.
        // Only the sweep just before that TERM records them, so a later member still gets one.
        if (row->pgid == w->group) {
            if (w->group_term_pending) {
                record_termed(w, row);
            }
            // Remembered too, so one that later leaves the group and its session is still the chat's.
            int settled = 1;
#if defined(__linux__)
            settled = row->start < scan_tick;
#endif
            if (settled && identity_reserve(&w->known)) {
                identity_insert(&w->known, row->pid, row->start, 0);
                seen_member(w, row);
            }
            continue;
        }
#if defined(__linux__)
        if (row->start >= scan_tick) {
            dropped = 1;
            continue;
        }
#endif
        if (deliver_to_member(w, row, signal_number)) {
            if (identity_reserve(&w->known)) {
                identity_insert(&w->known, row->pid, row->start, 0);
            }
            seen_member(w, row);
            live++;
        } else {
            // It may have forked after the table was read and exited since.
            dropped = 1;
        }
    }
    // A member proven by an earlier sweep stays one after its ancestry is gone; its handle decides.
    live += signal_unseen_known(w, signal_number, &dropped);
    // A dropped member may live on under a new parent, or in a child born after the table was read,
    // so this sweep cannot prove the tree empty.
    if (dropped && live == 0) {
        live = -1;
    }
#if defined(__linux__)
    // A hidden process may become visible (after an exec), so hidepid keeps retrying.
    if (hidden && live == 0) {
        live = -1;
    }
#endif
done:
    free(scan.rows);
    free(scan.state);
    free(scan.chain);
    return live;
}

#if defined(__linux__)
// Every live tree process descends from the subreaper, which adopts orphans, so the tree is empty
// only if its sole child is this watcher. 1 that holds, 0 another child exists or the list is
// unreadable, -1 the kernel doesn't provide the list.
static int reaper_has_only_watcher(const struct watcher *w) {
    char path[64];
    snprintf(path, sizeof path, "/proc/%ld/task/%ld/children", (long)w->reaper, (long)w->reaper);
    FILE *children = fopen(path, "re");
    if (children == NULL) {
        return errno == ENOENT ? -1 : 0;
    }
    long child;
    int only_watcher = 1;
    while (fscanf(children, "%ld", &child) == 1) {
        if (child != (long)getpid()) {
            only_watcher = 0;
        }
    }
    if (ferror(children)) {
        only_watcher = 0;
    }
    fclose(children);
    return only_watcher;
}
#endif

#if defined(__linux__)
// The subreaper adopts every orphan, so once the CLI group is gone a child list holding only this
// watcher proves the tree empty without a host-wide read. New children join the list's tail, so a
// read showing only this watcher can't have skipped a live one.
static int tree_proven_empty(const struct watcher *w) {
    struct pollfd anchor = {.fd = w->reaper_fd, .events = POLLIN};
    if (w->reaper_fd < 0 || w->reaper_start < 0 || poll(&anchor, 1, 0) != 0 ||
            procfs_in_own_namespace() != 1 || reaper_has_only_watcher(w) != 1) {
        return 0;
    }
    return poll(&anchor, 1, 0) == 0 && procfs_in_own_namespace() == 1;
}
#endif

// /proc is read one row at a time, so on Linux two empty scans in a row, and the subreaper having
// no child but this watcher, prove the tree gone.
// group_gone is the caller's one reading, so a PID reused as a group mid-sweep can't change the proof.
static int sweep_tree(struct watcher *w, int signal_number, int group_gone) {
#if defined(__linux__)
    if (group_gone && tree_proven_empty(w)) {
        return 0;
    }
#else
    (void)group_gone;
#endif
    int live = sweep_once(w, signal_number);
#if defined(__linux__)
    // The second read only serves an absence proof, which needs the CLI group gone.
    if (live == 0 && group_gone) {
        live = sweep_once(w, signal_number);
    }
    // While the CLI group lives its leader is the subreaper's child too; absence isn't claimed then.
    if (live == 0 && group_gone && reaper_has_only_watcher(w) == 0) {
        live = -1;
    }
#endif
    return live;
}
#else
static int sweep_tree(struct watcher *w, int signal_number, int group_gone) {
    (void)w;
    (void)signal_number;
    (void)group_gone;
    return 0;
}
#endif

// The next whole-table read backs off from 100 ms to 1 s; members or doubt are rechecked sooner.
static void schedule_next_check(struct watcher *w, long long now_ns, int live) {
    long long tick = (long long)TREE_SWEEP_INTERVAL_MS * 1000000LL;
    long long last_chance = w->deadline_ns - tick;
    // While members or doubt remain, recheck each interval; otherwise wait for the next full sweep.
    w->next_sweep_ns = live != 0 ? now_ns + tick : w->next_full_ns;
    // Backoff never skips the last sweep before the phase deadline, so a late tool still gets TERM.
    if (w->next_sweep_ns > last_chance && now_ns < last_chance) {
        w->next_sweep_ns = last_chance;
    }
}

static void schedule_after_full_sweep(struct watcher *w, int live) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        return;
    }
    long long now_ns = (long long)now.tv_sec * 1000000000LL + now.tv_nsec;
    long long interval = w->sweep_interval_ms > 0 ? w->sweep_interval_ms : TREE_SWEEP_INTERVAL_MS;
    w->sweep_interval_ms =
        interval * 2 > TREE_SWEEP_MAX_INTERVAL_MS ? TREE_SWEEP_MAX_INTERVAL_MS : interval * 2;
    w->next_full_ns = now_ns + interval * 1000000LL;
    schedule_next_check(w, now_ns, live);
}

// Rate-limited to one table read per sweep interval, backing off to 1 s while nothing is found.
// During TERM grace and reap it also sweeps while the CLI group lives, so a tool that was deferred
// or born late still gets its signal. Absence needs the group gone before the sweep began.
static int tree_absent(struct watcher *w, int signal_number) {
    int group_gone = group_absent(w);
    if (!group_gone && signal_number == 0) {
        return 0;
    }
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        return 0;
    }
    long long now_ns = (long long)now.tv_sec * 1000000000LL + now.tv_nsec;
    // The first sweep after the group is gone runs at once; completion waits on it.
    int first_gone = group_gone && !w->swept_group_gone;
    if (now_ns < w->next_sweep_ns && !first_gone) {
        return 0;
    }
    // An expired phase is left to its escalation, whose own sweep signals and decides.
    if (w->phase != WATCH_REAP && now_ns >= w->deadline_ns) {
        return 0;
    }
    w->swept_group_gone = group_gone;
    long long tick = (long long)TREE_SWEEP_INTERVAL_MS * 1000000LL;
    long long last_chance = w->deadline_ns - tick;
    // Known members are rechecked every interval; the whole table is read again only on its own
    // backoff, once none of them is left, or in the last interval before the phase deadline.
    int probed = w->known.count > 0;
#if defined(__linux__)
    // Probes trust /proc rows too, so an unproven namespace leaves the decision to a full sweep.
    int unproven = probed && procfs_in_own_namespace() != 1;
    probed = probed && !unproven;
#else
    int unproven = 0;
#endif
    int live = probed ? probe_known_members(w, signal_number) : 0;
    int full = unproven || (probed && live == 0) || first_gone || now_ns >= w->next_full_ns ||
               now_ns >= last_chance;
    if (full) {
        live = sweep_tree(w, signal_number, group_gone);
        schedule_after_full_sweep(w, live);
    } else {
        schedule_next_check(w, now_ns, live);
    }
    // Only a full sweep decides; a probe can show members alive but never prove the tree empty.
    if (!group_gone || !full) {
        return 0;
    }
    return live == 0 ? 1 : live == TREE_UNPROVABLE ? 2 : 0;
}

static long long monotonic_ns(struct watcher *w) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        kill(-w->group, SIGKILL);
        watcher_complete(0);
    }
    return (long long)now.tv_sec * 1000000000LL + now.tv_nsec;
}

// Once the CLI group is gone: a tool the CLI started after the first sweep is found by a second.
static void complete_if_tree_gone(struct watcher *w, int group_gone, int members, int signal_number) {
    // This confirmation counts as the first sweep after the group is gone.
    w->swept_group_gone = group_gone;
    if (!group_gone || (members != 0 && members != TREE_UNPROVABLE)) {
        return;
    }
    int again = members == 0 ? sweep_tree(w, signal_number, 1) : TREE_UNPROVABLE;
    if (again == 0 || again == TREE_UNPROVABLE) {
        watcher_complete(again == 0);
    }
}

static void kill_group(struct watcher *w) {
    if (w->phase == WATCH_REAP) {
        return;
    }
    int members = sweep_tree(w, SIGKILL, group_absent(w));
    schedule_after_full_sweep(w, members);
    int group_gone = kill(-w->group, SIGKILL) < 0 && errno == ESRCH;
    complete_if_tree_gone(w, group_gone, members, SIGKILL);
    w->phase = WATCH_REAP;
    w->deadline_ns = monotonic_ns(w) + (long long)WATCH_REAP_MS * 1000000LL;
}

// TERM grace starts once TERM is issued, so a late wakeup never spends it beforehand.
static void watcher_term(struct watcher *w) {
    // Group members seen by this sweep get the group TERM right after it.
    w->group_term_pending = 1;
    int members = sweep_tree(w, SIGTERM, group_absent(w));
    w->group_term_pending = 0;
    schedule_after_full_sweep(w, members);
    int group_gone = kill(-w->group, SIGTERM) < 0 && errno == ESRCH;
    complete_if_tree_gone(w, group_gone, members, SIGTERM);
    if (w->sigterm_grace_ms == 0) {
        kill_group(w);
        return;
    }
    w->phase = WATCH_TERM_GRACE;
    w->deadline_ns = monotonic_ns(w) + (long long)w->sigterm_grace_ms * 1000000LL;
}

static void watcher_stdin_grace(struct watcher *w) {
    if (w->stdin_end_grace_ms == 0) {
        watcher_term(w);
        return;
    }
    w->phase = WATCH_STDIN_GRACE;
    w->deadline_ns = monotonic_ns(w) + (long long)w->stdin_end_grace_ms * 1000000LL;
}

static void watcher_command(struct watcher *w) {
    size_t n = w->line_length;
    if (n == 9 && memcmp(w->line, "stdin-end", 9) == 0) {
        if (w->session && w->phase == WATCH_IDLE) {
            watcher_stdin_grace(w);
        }
    } else if (n == 4 && memcmp(w->line, "term", 4) == 0) {
        if (w->phase != WATCH_TERM_GRACE && w->phase != WATCH_REAP) {
            watcher_term(w);
        }
    } else if (n == 4 && memcmp(w->line, "reap", 4) == 0) {
        kill_group(w);
    } else if (n == 11 && memcmp(w->line, "leader-exit", 11) == 0) {
        if (!w->session || w->phase != WATCH_TERM_GRACE) {
            kill_group(w);
        }
    }
}

// Complete lines only; an overlong or unknown line is dropped through its newline.
static void watcher_input(struct watcher *w, const char *data, size_t length) {
    for (size_t i = 0; i < length; i++) {
        char c = data[i];
        if (c == '\n') {
            if (!w->discarding) {
                watcher_command(w);
            }
            w->line_length = 0;
            w->discarding = 0;
        } else if (w->line_length < sizeof w->line) {
            w->line[w->line_length++] = c;
        } else {
            w->discarding = 1;
        }
    }
}

static void watcher_owner_eof(struct watcher *w) {
    if (w->phase != WATCH_IDLE) {
        return;
    }
    if (w->session && w->close_stdin_end) {
        watcher_stdin_grace(w);
    } else {
        watcher_term(w);
    }
}

// Idle blocks indefinitely; stopping probes the CLI group, then the tree once that group is gone.
static _Noreturn void watch_owner(struct watcher *w) {
    int owner_open = 1;
    struct pollfd owner = {.fd = OWNER_FD, .events = POLLIN};
    for (;;) {
        int timeout = -1;
        if (w->phase != WATCH_IDLE) {
            int sweep_signal = w->phase == WATCH_REAP         ? SIGKILL
                               : w->phase == WATCH_TERM_GRACE ? SIGTERM
                                                              : 0;
            int tree = tree_absent(w, sweep_signal);
            if (tree != 0) {
                watcher_complete(tree == 1);
            }
            long long remaining = w->deadline_ns - monotonic_ns(w);
            if (remaining <= 0) {
                if (w->phase == WATCH_STDIN_GRACE) {
                    watcher_term(w);
                    continue;
                }
                if (w->phase == WATCH_REAP) {
                    watcher_complete(0);
                }
                kill_group(w);
                continue;
            }
            timeout = (int)((remaining + 999999LL) / 1000000LL);
            if (timeout > WATCH_POLL_MS) {
                timeout = WATCH_POLL_MS;
            }
        }
        int ready;
        ready = poll(owner_open ? &owner : NULL, owner_open ? 1 : 0, timeout);
        if (ready < 0) {
            if (errno == EINTR) {
                continue;
            }
            owner_open = 0;
            kill_group(w);
            continue;
        }
        if (ready == 0 || !owner_open) {
            continue;
        }
        // One bounded read per wake, so steady input cannot hold off a deadline.
        char data[WATCH_READ_MAX];
        ssize_t got = read(OWNER_FD, data, sizeof data);
        if (got > 0) {
            watcher_input(w, data, (size_t)got);
        } else if (got == 0 || (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK)) {
            // A failed read also means the owner is unreachable; its pipe leaves the poll set.
            // Retain the write side for completion when the owner only half-closed its pipe.
            owner_open = 0;
            watcher_owner_eof(w);
        }
    }
}

// Stop signals stay blocked from fork until the ignores are in place.
static _Noreturn void run_watcher(int report_fd, struct watcher *w) {
    static const int IGNORED_SIGNALS[] = {SIGTERM, SIGINT, SIGHUP, SIGUSR1, SIGPIPE};
    struct sigaction ignore;
    memset(&ignore, 0, sizeof ignore);
    ignore.sa_handler = SIG_IGN;
    sigemptyset(&ignore.sa_mask);
    if (setpgid(0, 0) != 0) {
        goto failed;
    }
    if (getpgrp() != getpid() || getsid(0) != w->group) {
        errno = EPERM;
        goto failed;
    }
    // Survives the group SIGTERM it sends.
    for (size_t i = 0; i < sizeof IGNORED_SIGNALS / sizeof IGNORED_SIGNALS[0]; i++) {
        if (sigaction(IGNORED_SIGNALS[i], &ignore, NULL) != 0) {
            goto failed;
        }
    }
    sigset_t none;
    sigemptyset(&none);
    if (sigprocmask(SIG_SETMASK, &none, NULL) != 0) {
        goto failed;
    }
    int null_fd = open("/dev/null", O_RDWR);
    if (null_fd < 0 || dup2(null_fd, 0) < 0 || dup2(null_fd, 1) < 0 || dup2(null_fd, 2) < 0) {
        goto failed;
    }
    close(null_fd);
    close(GATE_FD);
    close(STATUS_FD);
    close(INPUT_FD);
    struct timespec probe;
    if (chdir("/") != 0 || clock_gettime(CLOCK_MONOTONIC, &probe) != 0) {
        goto failed;
    }
    int ready = 0;
    if (write_all(report_fd, (const char *)&ready, sizeof ready) != 0) {
        _exit(EXIT_BOOTSTRAP);
    }
    close(report_fd);
    watch_owner(w);
failed:;
    int error = errno != 0 ? errno : EIO;
    write_all(report_fd, (const char *)&error, sizeof error);
    _exit(EXIT_BOOTSTRAP);
}

// Returns only once the watcher acknowledged it is ready, so its pid is safe to publish. EOF
// without that acknowledgement is a failed start.
static int start_watcher(struct watcher *w) {
    int report[2];
    if (pipe(report) != 0) {
        return -1;
    }
    if (set_cloexec(report[0], 1) != 0 || set_cloexec(report[1], 1) != 0) {
        close(report[0]);
        close(report[1]);
        return -1;
    }
    pid_t pid = fork();
    if (pid == 0) {
        close(report[0]);
        run_watcher(report[1], w);
    }
    close(report[1]);
    if (pid < 0) {
        close(report[0]);
        return -1;
    }
    watcher_pid = pid;
    int answer = -1;
    size_t have = 0;
    while (have < sizeof answer) {
        struct pollfd startup[] = {
            {.fd = report[0], .events = POLLIN}, {.fd = GATE_FD, .events = POLLIN}};
        int ready = poll(startup, 2, -1);
        if (ready < 0 && errno == EINTR) {
            continue;
        }
        // Gate cancellation must still reap a watcher stopped before its readiness reply.
        if (ready < 0 || startup[1].revents != 0) {
            break;
        }
        ssize_t got = read(report[0], (char *)&answer + have, sizeof answer - have);
        if (got < 0 && errno == EINTR) {
            continue;
        }
        if (got <= 0) {
            break;
        }
        have += (size_t)got;
    }
    close(report[0]);
    if (have != sizeof answer || answer != 0 || waitpid(pid, NULL, WNOHANG) != 0) {
        reap_watcher();
        return -1;
    }
    return 0;
}

static int await_gate(void) {
    static const char expected[] = "g\n";
    for (size_t i = 0; i < sizeof expected - 1;) {
        char byte;
        ssize_t got = read(GATE_FD, &byte, 1);
        if (got < 0 && errno == EINTR) {
            if (stop_signal != 0) {
                return -1;
            }
            continue;
        }
        if (got != 1 || byte != expected[i]) {
            return -1;
        }
        i++;
    }
    return 0;
}

static int install_stop_handlers(void) {
    struct sigaction handler;
    memset(&handler, 0, sizeof handler);
    handler.sa_handler = on_stop_signal;
    sigemptyset(&handler.sa_mask);
    for (int i = 0; i < STOP_SIGNAL_COUNT; i++) {
        if (sigaction(STOP_SIGNALS[i], NULL, &saved_stop_actions[i]) != 0) {
            return -1;
        }
        // An inherited ignore stays an ignore, as it would for the CLI itself.
        if (saved_stop_actions[i].sa_handler == SIG_DFL &&
                sigaction(STOP_SIGNALS[i], &handler, NULL) != 0) {
            return -1;
        }
    }
    struct sigaction ignore;
    memset(&ignore, 0, sizeof ignore);
    ignore.sa_handler = SIG_IGN;
    sigemptyset(&ignore.sa_mask);
    // A closed status reader must surface as EPIPE, not kill this pid with its watcher alive.
    return sigaction(SIGPIPE, &ignore, &saved_pipe_action);
}

static void restore_signal_actions(void) {
    for (int i = 0; i < STOP_SIGNAL_COUNT; i++) {
        sigaction(STOP_SIGNALS[i], &saved_stop_actions[i], NULL);
    }
    sigaction(SIGPIPE, &saved_pipe_action, NULL);
}

// The leader: runs today's bootstrap in a session of its own, then becomes the CLI.
static _Noreturn void run_leader(struct watcher *watcher, char *command[]) {
    // Only the parent may hold the outcome pipe, so its EOF means the parent is gone.
    close(OUTCOME_FD);
#if defined(__linux__)
    close(watcher_gone_fd);
#endif
    if (setsid() < 0 || sigaction(SIGCHLD, &saved_child_action, NULL) != 0 ||
            install_stop_handlers() != 0 || set_cloexec(OWNER_FD, 1) != 0 ||
            set_cloexec(GATE_FD, 1) != 0 || set_cloexec(STATUS_FD, 1) != 0) {
        fail(EXIT_BOOTSTRAP);
    }
    watcher->group = getpid();
#if defined(__linux__)
    // The parent recorded its own identity before fork; a different parent here is not ours.
    if (getppid() != watcher->reaper) {
        fail(EXIT_BOOTSTRAP);
    }
#elif defined(__APPLE__)
    struct proc_row leader_row;
    if (read_row(watcher->group, &leader_row) != 1) {
        fail(EXIT_BOOTSTRAP);
    }
    watcher->leader_start = leader_row.start;
    // Random, so no unrelated process can carry it by deriving it from public process data.
    unsigned char nonce[16];
    arc4random_buf(nonce, sizeof nonce);
    int tag_length = snprintf(watcher->tree_tag, sizeof watcher->tree_tag, TREE_TAG_NAME "=");
    for (size_t i = 0; i < sizeof nonce; i++) {
        tag_length += snprintf(watcher->tree_tag + tag_length,
                               sizeof watcher->tree_tag - (size_t)tag_length, "%02x", nonce[i]);
    }
#endif

    // Stop signals stay blocked from the parent's fork, so the watcher installs its ignores first.
    int started = start_watcher(watcher);
    sigprocmask(SIG_SETMASK, &saved_mask, NULL);
    if (started != 0 || stop_signal != 0) {
        fail(EXIT_BOOTSTRAP);
    }
    // Only the watcher holds the owner pipe, so its EOF on either side means the other died.
    close(OWNER_FD);

    char status[128];
    int length = snprintf(status, sizeof status, "{\"leaderPid\":%ld,\"watcherPid\":%ld}\n",
                          (long)watcher->group, (long)watcher_pid);
    if (length <= 0 || (size_t)length >= sizeof status ||
            write_all(STATUS_FD, status, (size_t)length) != 0) {
        fail(EXIT_BOOTSTRAP);
    }
    if (await_gate() != 0) {
        fail(EXIT_GATE_CLOSED);
    }
    close(GATE_FD);
    // The GUI owns this channel independently of the parent's ChildProcess stdin.
    if (dup2(INPUT_FD, STDIN_FILENO) < 0) {
        fail(EXIT_BOOTSTRAP);
    }
    close(INPUT_FD);

    sigprocmask(SIG_BLOCK, &stop_set, NULL);
    restore_signal_actions();
    sigset_t pending;
    sigpending(&pending);
    for (int i = 0; i < STOP_SIGNAL_COUNT; i++) {
        if (stop_signal == 0 && sigismember(&pending, STOP_SIGNALS[i]) == 1) {
            stop_signal = STOP_SIGNALS[i];
        }
    }
    // A stop during the gate, or a watcher that died before release, cancels the launch.
    if (stop_signal != 0 || waitpid(watcher_pid, NULL, WNOHANG) != 0) {
        fail(EXIT_GATE_CLOSED);
    }
    sigprocmask(SIG_SETMASK, &saved_mask, NULL);
#if defined(__APPLE__)
    if (setenv(TREE_TAG_NAME, strchr(watcher->tree_tag, '=') + 1, 1) != 0) {
        fail(EXIT_BOOTSTRAP);
    }
#endif

    execvp(command[0], command);
    int error = errno;
    signal(SIGPIPE, SIG_IGN);
    length = snprintf(status, sizeof status, "{\"errno\":%d}\n", error);
    if (length > 0 && (size_t)length < sizeof status) {
        write_all(STATUS_FD, status, (size_t)length);
    }
    reap_watcher();
    _exit(EXIT_EXEC_FAILED);
}

// One frame for the leader's actual wait status, then EOF.
static int publish_outcome(int status) {
    char frame[48];
    int length = WIFSIGNALED(status)
                     ? snprintf(frame, sizeof frame, "{\"code\":null,\"signal\":%d}\n",
                                WTERMSIG(status))
                     : snprintf(frame, sizeof frame, "{\"code\":%d,\"signal\":null}\n",
                                WEXITSTATUS(status));
    int written = length > 0 && (size_t)length < sizeof frame &&
                  write_all(OUTCOME_FD, frame, (size_t)length) == 0;
    close(OUTCOME_FD);
    return written ? 0 : -1;
}

#if defined(__linux__)
// Hangup means the watcher exited; on a failed probe it falls to the next reaper instead.
static int watcher_exited(void) {
    struct pollfd watcher = {.fd = watcher_gone_fd, .events = POLLIN};
    return poll(&watcher, 1, 0) != 0;
}
#endif

// Holds nothing the owner reads EOF from: stdio and fds 3-5 now belong to the leader and watcher.
// Survives stop signals, which the watcher turns into the group stop, and blocks in wait only.
static _Noreturn void await_leader(pid_t leader) {
    static const int IGNORED_SIGNALS[] = {SIGTERM, SIGINT, SIGHUP, SIGPIPE};
    struct sigaction ignore;
    memset(&ignore, 0, sizeof ignore);
    ignore.sa_handler = SIG_IGN;
    sigemptyset(&ignore.sa_mask);
    for (size_t i = 0; i < sizeof IGNORED_SIGNALS / sizeof IGNORED_SIGNALS[0]; i++) {
        sigaction(IGNORED_SIGNALS[i], &ignore, NULL);
    }
    sigprocmask(SIG_SETMASK, &saved_mask, NULL);
    close(INPUT_FD);
    int null_fd = open("/dev/null", O_RDWR | O_CLOEXEC);
    for (int fd = 0; fd <= STATUS_FD; fd++) {
        if (fd > 2 || null_fd < 0 || dup2(null_fd, fd) < 0) {
            close(fd);
        }
    }
    if (null_fd > STATUS_FD) {
        close(null_fd);
    }

    if (chdir("/") != 0) {
        // Keep reaping even if the current directory cannot be released.
    }
    // Stays 1 until the leader is reaped.
    int outcome = 1;
    for (;;) {
        int status;
        pid_t pid = waitpid(-1, &status, 0);
        if (pid < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }
        if (pid == leader) {
            outcome = publish_outcome(status);
#if !defined(__linux__)
            // Only the leader is this pid's child here; init reaps the watcher.
            break;
#endif
        }
#if defined(__linux__)
        // A watcher outliving the leader is adopted here, so its exit is a later wake of this wait.
        if (outcome != 1 && watcher_exited()) {
            while (waitpid(-1, NULL, WNOHANG) > 0) {
            }
            break;
        }
#endif
    }
    _exit(outcome == 0 ? 0 : outcome < 0 ? EXIT_OUTCOME_LOST : EXIT_BOOTSTRAP);
}

int main(int argc, char *argv[]) {
#if defined(__APPLE__)
    if (argc == 3 && strcmp(argv[1], "--process-row") == 0) {
        return print_process_row(argv[2]);
    }
#endif
#if defined(__linux__)
    if (argc >= 4 && strcmp(argv[1], "--exec-without-inherited-fds") == 0) {
        return strcmp(argv[2], "--") == 0 && argv[3][0] != '\0'
                   ? exec_without_inherited_fds(&argv[3])
                   : EXIT_USAGE;
    }
#endif
    unsigned stdin_end_grace_ms;
    unsigned sigterm_grace_ms;
    // A fixed protocol discriminator rejects mismatched helpers before a CLI can execute.
    if (argc < 8 || strcmp(argv[1], "--cli-input-fd7") != 0 ||
            parse_ms(argv[2], STDIN_END_GRACE_MAX_MS, &stdin_end_grace_ms) != 0 ||
            parse_ms(argv[3], SIGTERM_GRACE_MAX_MS, &sigterm_grace_ms) != 0 ||
            (strcmp(argv[4], "session") != 0 && strcmp(argv[4], "one-shot") != 0) ||
            (strcmp(argv[5], "stdin-end") != 0 && strcmp(argv[5], "stdin-end-and-sigterm") != 0) ||
            strcmp(argv[6], "--") != 0 || argv[7][0] == '\0') {
        return EXIT_USAGE;
    }
    for (int fd = 0; fd <= INPUT_FD; fd++) {
        if (fcntl(fd, F_GETFD) < 0) {
            return EXIT_USAGE;
        }
    }
    // A host passes its own nonblocking sockets; the gate, status and CLI stdio expect blocking ones.
    for (int fd = 1; fd <= INPUT_FD; fd++) {
        int flags = fcntl(fd, F_GETFL);
        if (flags < 0 || ((flags & O_NONBLOCK) && fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) != 0)) {
            return EXIT_BOOTSTRAP;
        }
    }

    struct watcher watcher = {
        .stdin_end_grace_ms = stdin_end_grace_ms,
        .sigterm_grace_ms = sigterm_grace_ms,
        .session = strcmp(argv[4], "session") == 0,
        .close_stdin_end = strcmp(argv[5], "stdin-end") == 0,
        .phase = WATCH_IDLE,
        .reaper_fd = -1,
    };
    sigset_t fork_set;
    sigemptyset(&stop_set);
    sigemptyset(&fork_set);
    for (int i = 0; i < STOP_SIGNAL_COUNT; i++) {
        sigaddset(&stop_set, STOP_SIGNALS[i]);
        sigaddset(&fork_set, STOP_SIGNALS[i]);
    }
    sigaddset(&fork_set, SIGPIPE);
    // An inherited SIGCHLD ignore would auto-reap the leader and lose its status; the leader
    // restores it for the CLI.
    struct sigaction child_default;
    memset(&child_default, 0, sizeof child_default);
    child_default.sa_handler = SIG_DFL;
    sigemptyset(&child_default.sa_mask);
    if (set_cloexec(OUTCOME_FD, 1) != 0 ||
            sigaction(SIGCHLD, &child_default, &saved_child_action) != 0) {
        return EXIT_BOOTSTRAP;
    }
#if defined(__linux__)
    // Without it the watcher and orphaned descendants would be left to a possibly non-reaping init,
    // so refuse before any CLI starts.
    if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
        return EXIT_NO_SUBREAPER;
    }
    int watcher_alive[2];
    if (pipe(watcher_alive) != 0 || set_cloexec(watcher_alive[0], 1) != 0 ||
            set_cloexec(watcher_alive[1], 1) != 0) {
        return EXIT_BOOTSTRAP;
    }
    watcher_gone_fd = watcher_alive[0];
    // A /proc from another PID namespace names other processes, so no tree is anchored on it.
    // The pidfd, taken while this pid is certainly itself, turns readable once it exits.
    watcher.reaper = getpid();
    watcher.reaper_start = REAPER_UNPROVEN;
    watcher.reaper_fd = (int)syscall(SYS_pidfd_open, getpid(), 0);
    if (watcher.reaper_fd >= 0 && set_cloexec(watcher.reaper_fd, 1) == 0) {
        // A read that fails now is retried on the first sweep; only a foreign /proc is lasting.
        struct proc_row reaper_row;
        int own = procfs_in_own_namespace();
        if (own == 1 && read_row(getpid(), &reaper_row) == 1) {
            watcher.reaper_start = reaper_row.start;
        } else if (own != 0) {
            watcher.reaper_start = REAPER_START_UNREAD;
        }
    }
#endif
    // Blocked across fork so a stop signal lands either before it (default action, nothing started)
    // or on the leader's handler or this pid's ignore, never on the defaults in between.
    if (sigprocmask(SIG_BLOCK, &fork_set, &saved_mask) != 0) {
        return EXIT_BOOTSTRAP;
    }
    pid_t leader = fork();
    if (leader == 0) {
        run_leader(&watcher, &argv[7]);
    }
    if (leader < 0) {
        return EXIT_BOOTSTRAP;
    }
#if defined(__linux__)
    close(watcher_alive[1]);
#endif
    await_leader(leader);
}
