#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(void) {
  const char *target = getenv("ORCA_PROBE_TARGET");
  const char *nonce = getenv("ORCA_PROBE_NONCE");
  if (!target || !nonce) return 2;
  alarm(5);
  if (getenv("ORCA_PROBE_STALL")) sleep(10);
  DIR *directory = opendir(target);
  int error = directory ? 0 : errno;
  if (directory) {
    errno = 0;
    readdir(directory);
    error = errno;
    closedir(directory);
  }
  printf("ORCA_PROBE:%s:%d\n", nonce, error);
  fflush(stdout);
  return error ? 1 : 0;
}
