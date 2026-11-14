// Gated exec for POSIX provider CLIs. Forks the in-group owner-pipe watcher, reports it on fd 5,
// waits for the owner's GO on fd 4, then execs the CLI with its argv and environment unchanged.
// Usage: orca-provider-exec <stdinEndGraceMs> <sigtermGraceMs> <session|one-shot>
//          <stdin-end|stdin-end-and-sigterm> -- <command> [args...]
#if !defined(__APPLE__)
#define _POSIX_C_SOURCE 200809L
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
#if defined(__APPLE__)
#include <sys/sysctl.h>
#endif

enum { OWNER_FD = 3, GATE_FD = 4, STATUS_FD = 5 };
enum { EXIT_USAGE = 64, EXIT_GATE_CLOSED = 69, EXIT_BOOTSTRAP = 71, EXIT_EXEC_FAILED = 127 };
enum { STDIN_END_GRACE_MAX_MS = 1000, SIGTERM_GRACE_MAX_MS = 3000 };

static const int STOP_SIGNALS[] = {SIGTERM, SIGINT, SIGHUP};
enum { STOP_SIGNAL_COUNT = sizeof STOP_SIGNALS / sizeof STOP_SIGNALS[0] };

static volatile sig_atomic_t stop_signal = 0;
static struct sigaction saved_stop_actions[STOP_SIGNAL_COUNT];
static struct sigaction saved_pipe_action;
static sigset_t saved_mask;
static sigset_t stop_set;
static pid_t watcher_pid = -1;

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
        value = value * 10 + (unsigned)(*c - '0');
        if (value > max) {
            return -1;
        }
    }
    *out = value;
    return 0;
}

static int is_uuid(const char *text) {
    if (strlen(text) != 36) {
        return 0;
    }
    for (int i = 0; i < 36; i++) {
        char c = text[i];
        int hyphen = i == 8 || i == 13 || i == 18 || i == 23;
        int hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        if (hyphen ? c != '-' : !hex) {
            return 0;
        }
    }
    return 1;
}

// Empty when the host withholds it; the owner then treats boot identity as unknown.
static void read_boot_id(char out[37]) {
    char value[64] = {0};
    out[0] = '\0';
#if defined(__APPLE__)
    size_t size = sizeof value - 1;
    if (sysctlbyname("kern.bootsessionuuid", value, &size, NULL, 0) != 0) {
        return;
    }
    value[size < sizeof value ? size : sizeof value - 1] = '\0';
#else
    int fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        return;
    }
    ssize_t got;
    do {
        got = read(fd, value, sizeof value - 1);
    } while (got < 0 && errno == EINTR);
    close(fd);
    if (got <= 0) {
        return;
    }
    value[got] = '\0';
    value[strcspn(value, "\n")] = '\0';
#endif
    if (is_uuid(value)) {
        memcpy(out, value, 37);
    }
}

static int set_cloexec(int fd, int enabled) {
    int flags = fcntl(fd, F_GETFD);
    if (flags < 0) {
        return -1;
    }
    flags = enabled ? flags | FD_CLOEXEC : flags & ~FD_CLOEXEC;
    return fcntl(fd, F_SETFD, flags);
}

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

// The watcher runs in this group for the launch's whole life and holds the owner pipe (fd 3).
// Commands there are stdin-end, term and reap; EOF there is owner death. One phase and absolute
// deadline own the stop, so owner EOF resumes it and a repeated term never restarts or shortens it.
enum watcher_phase { WATCH_IDLE, WATCH_STDIN_GRACE, WATCH_TERM_GRACE };
enum { WATCH_LINE_MAX = 32, WATCH_READ_MAX = 256 };

struct watcher {
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

// Also ends the watcher, which never leaves the group before its final KILL.
static _Noreturn void kill_group(void) {
    kill(0, SIGKILL);
    _exit(EXIT_BOOTSTRAP);
}

static long long monotonic_ns(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        kill_group();
    }
    return (long long)now.tv_sec * 1000000000LL + now.tv_nsec;
}

// TERM grace starts once TERM is issued, so a late wakeup never spends it beforehand.
static void watcher_term(struct watcher *w) {
    kill(0, SIGTERM);
    if (w->sigterm_grace_ms == 0) {
        kill_group();
    }
    w->phase = WATCH_TERM_GRACE;
    w->deadline_ns = monotonic_ns() + (long long)w->sigterm_grace_ms * 1000000LL;
}

static void watcher_stdin_grace(struct watcher *w) {
    if (w->stdin_end_grace_ms == 0) {
        watcher_term(w);
        return;
    }
    w->phase = WATCH_STDIN_GRACE;
    w->deadline_ns = monotonic_ns() + (long long)w->stdin_end_grace_ms * 1000000LL;
}

static void watcher_command(struct watcher *w) {
    size_t n = w->line_length;
    if (n == 9 && memcmp(w->line, "stdin-end", 9) == 0) {
        if (w->session && w->phase == WATCH_IDLE) {
            watcher_stdin_grace(w);
        }
    } else if (n == 4 && memcmp(w->line, "term", 4) == 0) {
        if (w->phase != WATCH_TERM_GRACE) {
            watcher_term(w);
        }
    } else if (n == 4 && memcmp(w->line, "reap", 4) == 0) {
        kill_group();
    } else if (n == 11 && memcmp(w->line, "leader-exit", 11) == 0) {
        if (!w->session || w->phase != WATCH_TERM_GRACE) {
            kill_group();
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

// Idle blocks in poll with no timeout; only a started stop phase wakes on its deadline.
static _Noreturn void watch_owner(struct watcher *w) {
    int owner_open = 1;
    struct pollfd owner = {.fd = OWNER_FD, .events = POLLIN};
    for (;;) {
        int timeout = -1;
        if (w->phase != WATCH_IDLE) {
            long long remaining = w->deadline_ns - monotonic_ns();
            if (remaining <= 0) {
                if (w->phase == WATCH_STDIN_GRACE) {
                    watcher_term(w);
                    continue;
                }
                kill_group();
            }
            timeout = (int)((remaining + 999999LL) / 1000000LL);
        }
        int ready;
        if (owner_open) {
            ready = poll(&owner, 1, timeout);
        } else {
            // Owner EOF always leaves idle, so there is a deadline to wait for.
            struct timespec wait = {timeout / 1000, (long)(timeout % 1000) * 1000000L};
            ready = nanosleep(&wait, NULL);
        }
        if (ready < 0) {
            if (errno == EINTR) {
                continue;
            }
            kill_group();
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
            close(OWNER_FD);
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

int main(int argc, char *argv[]) {
    unsigned stdin_end_grace_ms;
    unsigned sigterm_grace_ms;
    if (argc < 7 || parse_ms(argv[1], STDIN_END_GRACE_MAX_MS, &stdin_end_grace_ms) != 0 ||
            parse_ms(argv[2], SIGTERM_GRACE_MAX_MS, &sigterm_grace_ms) != 0 ||
            (strcmp(argv[3], "session") != 0 && strcmp(argv[3], "one-shot") != 0) ||
            (strcmp(argv[4], "stdin-end") != 0 && strcmp(argv[4], "stdin-end-and-sigterm") != 0) ||
            strcmp(argv[5], "--") != 0 || argv[6][0] == '\0') {
        return EXIT_USAGE;
    }
    // The owner signals and records this pid as the CLI's group, so it must lead one.
    for (int fd = 0; fd <= STATUS_FD; fd++) {
        if (fcntl(fd, F_GETFD) < 0) {
            return EXIT_USAGE;
        }
    }
    if (getpid() != getpgrp()) {
        return EXIT_USAGE;
    }

    sigemptyset(&stop_set);
    for (int i = 0; i < STOP_SIGNAL_COUNT; i++) {
        sigaddset(&stop_set, STOP_SIGNALS[i]);
    }
    if (sigprocmask(SIG_SETMASK, NULL, &saved_mask) != 0 || install_stop_handlers() != 0 ||
            set_cloexec(OWNER_FD, 1) != 0 || set_cloexec(GATE_FD, 1) != 0 ||
            set_cloexec(STATUS_FD, 1) != 0) {
        fail(EXIT_BOOTSTRAP);
    }

    struct watcher watcher = {
        .stdin_end_grace_ms = stdin_end_grace_ms,
        .sigterm_grace_ms = sigterm_grace_ms,
        .session = strcmp(argv[3], "session") == 0,
        .close_stdin_end = strcmp(argv[4], "stdin-end") == 0,
        .phase = WATCH_IDLE,
    };

    // Blocked across fork so the watcher installs its ignores before any stop signal can land.
    sigprocmask(SIG_BLOCK, &stop_set, NULL);
    int started = stop_signal == 0 ? start_watcher(&watcher) : -1;
    sigprocmask(SIG_SETMASK, &saved_mask, NULL);
    if (started != 0 || stop_signal != 0) {
        fail(EXIT_BOOTSTRAP);
    }
    // Only the watcher holds the owner pipe, so its EOF on either side means the other died.
    close(OWNER_FD);

    char boot_id[37];
    read_boot_id(boot_id);
    char status[96];
    int length = boot_id[0] != '\0'
                     ? snprintf(status, sizeof status, "{\"watcherPid\":%ld,\"bootId\":\"%s\"}\n",
                                (long)watcher_pid, boot_id)
                     : snprintf(status, sizeof status, "{\"watcherPid\":%ld,\"bootId\":null}\n",
                                (long)watcher_pid);
    if (length <= 0 || (size_t)length >= sizeof status ||
            write_all(STATUS_FD, status, (size_t)length) != 0) {
        fail(EXIT_BOOTSTRAP);
    }
    if (await_gate() != 0) {
        fail(EXIT_GATE_CLOSED);
    }
    close(GATE_FD);

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

    execvp(argv[6], &argv[6]);
    int error = errno;
    signal(SIGPIPE, SIG_IGN);
    length = snprintf(status, sizeof status, "{\"errno\":%d}\n", error);
    if (length > 0 && (size_t)length < sizeof status) {
        write_all(STATUS_FD, status, (size_t)length);
    }
    reap_watcher();
    _exit(EXIT_EXEC_FAILED);
}
