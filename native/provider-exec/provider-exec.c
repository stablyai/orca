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
#endif

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
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
enum { TREE_SWEEP_INTERVAL_MS = 100 };
// Inherited by every tool the CLI starts, so one reparented to launchd is still found on macOS.
#define TREE_TAG_NAME "ORCA_PROVIDER_TREE"

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
    struct termed {
        pid_t pid;
        long long start;
    } *termed;
    size_t termed_count;
    size_t termed_capacity;
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
static void row_from_kinfo(const struct kinfo_proc *k, struct proc_row *row) {
    row->pid = k->kp_proc.p_pid;
    row->ppid = k->kp_eproc.e_ppid;
    row->pgid = k->kp_eproc.e_pgid;
    row->uid = k->kp_eproc.e_ucred.cr_uid;
    row->start = (long long)k->kp_proc.p_starttime.tv_sec * 1000000LL +
                 (long long)k->kp_proc.p_starttime.tv_usec;
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
            return 0;
        }
        args_max = (size_t)max;
    }
    int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
    size_t size = args_max;
    if (sysctl(mib, 3, args, &size, NULL, 0) != 0 || size < sizeof(int)) {
        return 0;
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
            return 0;
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
    unsigned long long start;
    if (fields == NULL ||
            sscanf(fields + 1,
                " %c %d %d %*d %*d %*d %*u %*u %*u %*u %*u %*u %*u %*d %*d %*d %*d %*d %*d %llu",
                &state, &ppid, &pgid, &start) != 4) {
        return -1;
    }
    row->pid = pid;
    row->ppid = ppid;
    row->pgid = pgid;
    row->uid = 0;
    row->start = (long long)start;
    row->zombie = state == 'Z' || state == 'X';
    row->stale = 0;
    return 1;
}

// NSpid lists this process's PID in the procfs mount's namespace and each nested one, so a single
// entry equal to getpid() proves /proc describes this namespace.
static int procfs_in_own_namespace(void) {
    FILE *status = fopen("/proc/self/status", "re");
    if (status == NULL) {
        return 0;
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
    fclose(status);
    return own;
}

static struct proc_row *read_table(size_t *count) {
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
    pid_t *sids;
    size_t sid_count;
    int leader_alive;
};

#if defined(__APPLE__)
static int member_session(const struct tree_scan *scan, pid_t sid) {
    for (size_t i = 0; i < scan->sid_count; i++) {
        if (scan->sids[i] == sid) {
            return 1;
        }
    }
    return 0;
}
#endif

// The row's process still holds that PID, so whatever was read about it since the row is its own.
static int same_identity(const struct proc_row *row) {
    struct proc_row now;
    return read_row(row->pid, &now) == 1 && now.start == row->start && !now.zombie;
}

enum { TREE_UNKNOWN, TREE_ANCESTRY, TREE_OUTSIDE, TREE_TAGGED };

// TREE_ANCESTRY: kernel parent links or a proven session lead to the CLI. TREE_TAGGED: a launchd
// orphan known only by the tag, which admits itself and its live descendants but never its
// session, since a tag alone does not prove who else shares it.
static int tree_root(struct watcher *w, const struct tree_scan *scan, const struct proc_row *row) {
#if defined(__linux__)
    (void)scan;
    return row->ppid == w->reaper ? TREE_ANCESTRY : TREE_UNKNOWN;
#else
    if (scan->leader_alive && row->ppid == w->group) {
        return TREE_ANCESTRY;
    }
    if (row->ppid != 1 || row->uid != geteuid() || row->start < w->leader_start || row->zombie) {
        return TREE_UNKNOWN;
    }
    pid_t sid = getsid(row->pid);
    int kind = sid > 0 && member_session(scan, sid)       ? TREE_ANCESTRY
               : carries_tree_tag(row->pid, w->tree_tag) ? TREE_TAGGED
                                                         : TREE_UNKNOWN;
    return kind != TREE_UNKNOWN && same_identity(row) ? kind : TREE_UNKNOWN;
#endif
}

static int tree_member(unsigned char state) {
    return state == TREE_ANCESTRY || state == TREE_TAGGED;
}

// Resolved once along each ancestor chain; descendants take their root's kind. A stale row is
// neither a member nor a parent.
static void resolve_members(struct watcher *w, struct tree_scan *scan) {
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
            int root = tree_root(w, scan, row);
            if (root != TREE_UNKNOWN) {
                verdict = (unsigned char)root;
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
}

#if defined(__APPLE__)
// Only a session read between two identity checks of a member is that member's session.
static void collect_member_sessions(struct watcher *w, struct tree_scan *scan) {
    scan->sid_count = 0;
    scan->sids[scan->sid_count++] = w->group;
    for (;;) {
        resolve_members(w, scan);
        size_t before = scan->sid_count;
        for (size_t i = 0; i < scan->n; i++) {
            const struct proc_row *row = &scan->rows[i];
            if (scan->state[i] != TREE_ANCESTRY || row->zombie) {
                continue;
            }
            pid_t sid = getsid(row->pid);
            if (sid > 0 && !member_session(scan, sid) && scan->sid_count <= scan->n &&
                    same_identity(row)) {
                scan->sids[scan->sid_count++] = sid;
            }
        }
        if (scan->sid_count == before) {
            return;
        }
    }
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
#endif

// Returns whether the member may still be alive. The kernel handle is taken before the start-time
// check, so the signal reaches that process or none: a pidfd on Linux, an audit token (which
// carries the PID version) on macOS. A member whose handle is refused is never signalled, and
// counts as alive unless it is gone.
static int signal_member(struct proc_row *row, int signal_number) {
#if defined(__linux__)
    int fd = (int)syscall(SYS_pidfd_open, row->pid, 0);
    if (fd < 0) {
        return errno != ESRCH && same_identity(row);
    }
    int alive = same_identity(row);
    if (alive && signal_number != 0) {
        syscall(SYS_pidfd_send_signal, fd, signal_number, NULL, 0);
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
        proc_signal_with_audittoken(&token, signal_number);
    }
    return alive;
#endif
}

static int already_termed(const struct watcher *w, const struct proc_row *row) {
    for (size_t i = 0; i < w->termed_count; i++) {
        if (w->termed[i].pid == row->pid && w->termed[i].start == row->start) {
            return 1;
        }
    }
    return 0;
}

static int record_termed(struct watcher *w, const struct proc_row *row) {
    if (w->termed_count == w->termed_capacity) {
        size_t capacity = w->termed_capacity > 0 ? w->termed_capacity * 2 : 16;
        void *grown = realloc(w->termed, capacity * sizeof *w->termed);
        if (grown == NULL) {
            return 0;
        }
        w->termed = grown;
        w->termed_capacity = capacity;
    }
    w->termed[w->termed_count].pid = row->pid;
    w->termed[w->termed_count].start = row->start;
    w->termed_count++;
    return 1;
}

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
    struct pollfd anchor = {.fd = w->reaper_fd, .events = POLLIN};
    if (w->reaper_fd < 0 || poll(&anchor, 1, 0) != 0) {
        // The subreaper exited (or its pidfd is unusable), so its PID anchors nothing.
        return -1;
    }
#endif
    scan.rows = read_table(&scan.n);
    if (scan.rows == NULL) {
        return -1;
    }
    size_t slots = scan.n > 0 ? scan.n : 1;
    qsort(scan.rows, scan.n, sizeof *scan.rows, compare_row_pid);
    scan.state = malloc(slots);
    scan.chain = malloc(slots * sizeof *scan.chain);
    scan.sids = malloc((slots + 1) * sizeof *scan.sids);
    int live = -1;
    if (scan.state == NULL || scan.chain == NULL || scan.sids == NULL) {
        goto done;
    }
#if defined(__linux__)
    // Orphans are adopted by this exact subreaper; any other process at its PID anchors nothing.
    const struct proc_row *reaper = find_row(scan.rows, scan.n, w->reaper);
    if (reaper == NULL || reaper->start != w->reaper_start || !same_identity(reaper)) {
        goto done;
    }
#endif
    const struct proc_row *leader = find_row(scan.rows, scan.n, w->group);
    scan.leader_alive = leader != NULL && !leader->zombie && leader->start == w->leader_start;
    int dropped = 0;
    for (;;) {
#if defined(__APPLE__)
        collect_member_sessions(w, &scan);
#else
        resolve_members(w, &scan);
#endif
        if (!drop_stale_members(&scan, leader)) {
            break;
        }
        dropped = 1;
    }
    live = 0;
    for (size_t i = 0; i < scan.n; i++) {
        struct proc_row *row = &scan.rows[i];
        // The CLI group gets its own signal, so its members are never signalled twice.
        if (!tree_member(scan.state[i]) || row->zombie || row->pgid == w->group) {
            continue;
        }
#if defined(__linux__)
        if (row->start >= scan_tick) {
            dropped = 1;
            continue;
        }
#endif
        // A member already sent TERM is only probed; one that can't be recorded is not sent it.
        int send = signal_number;
        if (signal_number == SIGTERM && (already_termed(w, row) || !record_termed(w, row))) {
            send = 0;
        }
        if (signal_member(row, send)) {
            live++;
        } else {
            // It may have forked after the table was read and exited since.
            dropped = 1;
        }
    }
    // A dropped member may live on under a new parent, or in a child born after the table was read,
    // so this sweep cannot prove the tree empty.
    if (dropped && live == 0) {
        live = -1;
    }
done:
    free(scan.rows);
    free(scan.state);
    free(scan.chain);
    free(scan.sids);
    return live;
}

// /proc is read one row at a time, so on Linux only two empty scans in a row prove the tree gone.
static int sweep_tree(struct watcher *w, int signal_number) {
    int live = sweep_once(w, signal_number);
#if defined(__linux__)
    if (live == 0) {
        live = sweep_once(w, signal_number);
    }
#endif
    return live;
}
#else
static int sweep_tree(struct watcher *w, int signal_number) {
    (void)w;
    (void)signal_number;
    return 0;
}
#endif

// Rate-limited to one table read per sweep interval.
// During TERM grace it also sweeps while the CLI group lives, so a tool that was deferred or born
// late still gets TERM before KILL. Absence needs the group gone before the sweep began.
static int tree_absent(struct watcher *w, int signal_number) {
    int group_gone = group_absent(w);
    if (!group_gone && signal_number != SIGTERM) {
        return 0;
    }
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        return 0;
    }
    long long now_ns = (long long)now.tv_sec * 1000000000LL + now.tv_nsec;
    // The first sweep after the group is gone runs at once; completion waits on it.
    if (now_ns < w->next_sweep_ns && (!group_gone || w->swept_group_gone)) {
        return 0;
    }
    w->swept_group_gone = group_gone;
    w->next_sweep_ns = now_ns + (long long)TREE_SWEEP_INTERVAL_MS * 1000000LL;
    return sweep_tree(w, signal_number) == 0 && group_gone;
}

static long long monotonic_ns(struct watcher *w) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        kill(-w->group, SIGKILL);
        watcher_complete(0);
    }
    return (long long)now.tv_sec * 1000000000LL + now.tv_nsec;
}

static void kill_group(struct watcher *w) {
    if (w->phase == WATCH_REAP) {
        return;
    }
    int members = sweep_tree(w, SIGKILL);
    // A tool the CLI started after that sweep is found by the one after the group is gone.
    if (kill(-w->group, SIGKILL) < 0 && errno == ESRCH && members == 0 &&
            sweep_tree(w, SIGKILL) == 0) {
        watcher_complete(1);
    }
    w->phase = WATCH_REAP;
    w->deadline_ns = monotonic_ns(w) + (long long)WATCH_REAP_MS * 1000000LL;
}

// TERM grace starts once TERM is issued, so a late wakeup never spends it beforehand.
static void watcher_term(struct watcher *w) {
    int members = sweep_tree(w, SIGTERM);
    if (kill(-w->group, SIGTERM) < 0 && errno == ESRCH && members == 0 &&
            sweep_tree(w, SIGTERM) == 0) {
        watcher_complete(1);
    }
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
            if (tree_absent(w, sweep_signal)) {
                watcher_complete(1);
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
    struct proc_row reaper_row;
    // The pidfd, taken while this pid is certainly itself, turns readable once it exits.
    watcher.reaper_fd = (int)syscall(SYS_pidfd_open, getpid(), 0);
    if (watcher.reaper_fd >= 0 && set_cloexec(watcher.reaper_fd, 1) == 0 &&
            procfs_in_own_namespace() && read_row(getpid(), &reaper_row) == 1) {
        watcher.reaper = reaper_row.pid;
        watcher.reaper_start = reaper_row.start;
    } else {
        watcher.reaper = getpid();
        watcher.reaper_start = -1;
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
