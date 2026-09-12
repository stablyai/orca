#include <copyfile.h>
#include <errno.h>
#include <fts.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/clonefile.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

static int clone_tree(const char *source, const char *target) {
  char *paths[] = {(char *)source, NULL};
  FTS *tree = fts_open(paths, FTS_PHYSICAL | FTS_NOCHDIR | FTS_XDEV, NULL);
  if (!tree) return -1;
  const size_t source_length = strlen(source);
  dev_t source_device = 0;
  int failure = 0;
  FTSENT *entry;
  errno = 0;
  while ((entry = fts_read(tree)) != NULL) {
    if (entry->fts_info == FTS_ERR || entry->fts_info == FTS_DNR ||
        entry->fts_info == FTS_NS || entry->fts_info == FTS_DC) {
      failure = entry->fts_errno ? entry->fts_errno : EIO;
      break;
    }
    if (entry->fts_level == 0) source_device = entry->fts_statp->st_dev;
    if (entry->fts_statp->st_dev != source_device) {
      failure = EXDEV;
      break;
    }
    char destination[PATH_MAX];
    const char *suffix = entry->fts_path + source_length;
    int length = snprintf(destination, sizeof(destination), "%s%s%s", target,
                          *suffix && *suffix != '/' ? "/" : "", suffix);
    if (length < 0 || (size_t)length >= sizeof(destination)) {
      failure = ENAMETOOLONG;
      break;
    }
    int result = 0;
    switch (entry->fts_info) {
      case FTS_D:
        result = mkdir(destination, 0700);
        break;
      case FTS_DP:
        result = copyfile(entry->fts_path, destination, NULL,
                          COPYFILE_METADATA | COPYFILE_NOFOLLOW);
        break;
      case FTS_F:
      case FTS_SL:
      case FTS_SLNONE:
        result = clonefile(entry->fts_path, destination,
                           CLONE_NOFOLLOW | CLONE_NOOWNERCOPY | CLONE_ACL);
        break;
      default:
        errno = ENOTSUP;
        result = -1;
    }
    if (result != 0) {
      failure = errno;
      break;
    }
    errno = 0;
  }
  if (!failure && errno) failure = errno;
  if (fts_close(tree) != 0 && !failure) failure = errno;
  errno = failure;
  return failure ? -1 : 0;
}

static int probe(const char *source, const char *target_parent) {
  struct statfs source_fs, target_fs;
  struct stat source_stat, target_stat;
  if (statfs(source, &source_fs) || statfs(target_parent, &target_fs) ||
      stat(source, &source_stat) || stat(target_parent, &target_stat)) return -1;
  if (strcmp(source_fs.f_fstypename, "apfs") ||
      strcmp(target_fs.f_fstypename, "apfs") || source_stat.st_dev != target_stat.st_dev) {
    errno = EXDEV;
    return -1;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 4) return 64;
  int result;
  if (!strcmp(argv[1], "clone")) {
    size_t length = strlen(argv[2]);
    while (length > 1 && argv[2][length - 1] == '/') argv[2][--length] = '\0';
    result = clone_tree(argv[2], argv[3]);
  } else if (!strcmp(argv[1], "publish")) {
    result = renamex_np(argv[2], argv[3], RENAME_EXCL);
  } else if (!strcmp(argv[1], "probe")) {
    result = probe(argv[2], argv[3]);
  } else {
    return 64;
  }
  if (result != 0) {
    fprintf(stderr, "{\"errno\":%d}\n", errno);
    return 1;
  }
  return 0;
}
