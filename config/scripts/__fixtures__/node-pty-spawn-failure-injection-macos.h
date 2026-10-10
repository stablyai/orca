// Inject only after the real posix_spawn succeeds, not during slave setup.
static int test_master = -1;
static pid_t test_pid = -1;

static int test_posix_openpt(int flags) {
  test_master = posix_openpt(flags);
  return test_master;
}

static int test_posix_spawn(pid_t* pid, const char* path,
                           const posix_spawn_file_actions_t* actions,
                           const posix_spawnattr_t* attributes,
                           char* const argv[], char* const env[]) {
  const int result = posix_spawn(pid, path, actions, attributes, argv, env);
  if (result == 0) test_pid = *pid;
  return result;
}

static int test_fcntl(int fd, int command, int argument = 0) {
  const char* failure = getenv("ORCA_PTY_TEST_FAILURE");
  const char* name = command == F_GETFL ? "F_GETFL" :
                     command == F_SETFL ? "F_SETFL" :
                     command == F_GETFD ? "F_GETFD" : "F_SETFD";
  if (test_pid > 0 && fd == test_master && failure && strcmp(failure, name) == 0) {
    errno = EIO;
    return -1;
  }
  return fcntl(fd, command, argument);
}

static Napi::Value TestSpawnState(const Napi::CallbackInfo& info) {
  if (test_pid <= 0 || test_master < 0) {
    throw Napi::Error::New(info.Env(), "Test posix_spawn did not create a child and master");
  }
  Napi::Object state = Napi::Object::New(info.Env());
  int flags = fcntl(test_master, F_GETFD);
  state.Set("masterClosed", flags == -1 && errno == EBADF);
  state.Set("cloexec", flags >= 0 && (flags & FD_CLOEXEC) != 0);
  int status = 0;
  pid_t waited;
  do {
    waited = waitpid(test_pid, &status, WNOHANG);
  } while (waited == -1 && errno == EINTR);
  state.Set("childReaped", waited == -1 && errno == ECHILD);
  // A failed assertion must not leave the spawned child or its master behind.
  if (getenv("ORCA_PTY_TEST_FAILURE")) {
    if (flags >= 0) close(test_master);
    if (waited == 0) {
      kill(test_pid, SIGKILL);
      while (waitpid(test_pid, &status, 0) == -1 && errno == EINTR) {}
    }
  }
  return state;
}

#define posix_openpt test_posix_openpt
#define posix_spawn test_posix_spawn
#define fcntl test_fcntl
