// Inject failures only in a disposable test addon, after system headers are included.
#include <sys/prctl.h>

static int test_master = -1;
static pid_t test_pid = -1;
static int test_wait_interrupts = 0;
static int test_blocking_interrupts = 0;
static int test_kills = 0;

static int test_fcntl(int fd, int command, int argument = 0) {
  const char* failure = getenv("ORCA_PTY_TEST_FAILURE");
  const char* name = command == F_GETFL ? "F_GETFL" :
                     command == F_SETFL ? "F_SETFL" :
                     command == F_GETFD ? "F_GETFD" : "F_SETFD";
  if (failure && strcmp(failure, name) == 0) {
    errno = EIO;
    return -1;
  }
  return fcntl(fd, command, argument);
}

static pid_t test_forkpty(int* master, char* name, const termios* term, const winsize* size) {
  int ready[2];
  if (pipe(ready) == -1) return -1;
  const pid_t parent_pid = getpid();
  pid_t pid = forkpty(master, name, term, size);
  if (pid == 0) {
    // A timed-out probe must not leave its deliberately stubborn child behind.
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) == -1 || getppid() != parent_pid) _exit(2);
    close(ready[0]);
    if (getenv("ORCA_PTY_TEST_FAILURE") && !getenv("ORCA_PTY_TEST_REAPED")) {
      signal(SIGHUP, SIG_IGN);
      signal(SIGTERM, SIG_IGN);
      char byte = 1;
      if (write(ready[1], &byte, 1) != 1) _exit(2);
      close(ready[1]);
      for (;;) pause();
    }
    close(ready[1]);
  } else {
    close(ready[1]);
    if (pid > 0) {
      test_master = *master;
      test_pid = pid;
      char byte;
      while (read(ready[0], &byte, 1) == -1 && errno == EINTR) {}
      if (getenv("ORCA_PTY_TEST_REAPED")) {
        int status;
        while (waitpid(pid, &status, 0) == -1 && errno == EINTR) {}
      }
    }
    close(ready[0]);
  }
  return pid;
}

static pid_t test_waitpid(pid_t pid, int* status, int options) {
  if (getenv("ORCA_PTY_TEST_EINTR")) {
    int& interrupts = options == WNOHANG ? test_wait_interrupts : test_blocking_interrupts;
    if (interrupts++ < 2) {
      errno = EINTR;
      return -1;
    }
  }
  return waitpid(pid, status, options);
}

static int test_kill(pid_t pid, int signal) {
  test_kills++;
  return kill(pid, signal);
}

static Napi::Value TestSpawnState(const Napi::CallbackInfo& info) {
  if (test_pid <= 0 || test_master < 0) {
    throw Napi::Error::New(info.Env(), "Test spawn did not create a child and master");
  }
  Napi::Object state = Napi::Object::New(info.Env());
  int flags = fcntl(test_master, F_GETFD);
  state.Set("masterClosed", flags == -1 && errno == EBADF);
  state.Set("cloexec", flags >= 0 && (flags & FD_CLOEXEC) != 0);
  int status = 0;
  pid_t waited = waitpid(test_pid, &status, WNOHANG);
  state.Set("childReaped", waited == -1 && errno == ECHILD);
  state.Set("waitInterrupts", test_wait_interrupts);
  state.Set("blockingInterrupts", test_blocking_interrupts);
  state.Set("kills", test_kills);
  // Failed baseline tests must not strand the child or its master.
  if (getenv("ORCA_PTY_TEST_FAILURE")) {
    if (flags >= 0) close(test_master);
    if (waited == 0) {
      kill(test_pid, SIGKILL);
      while (waitpid(test_pid, &status, 0) == -1 && errno == EINTR) {}
    }
  }
  return state;
}

#define fcntl test_fcntl
#define forkpty test_forkpty
#define waitpid test_waitpid

#define kill test_kill
