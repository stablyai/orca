// Native chat transcript resolution reads the OS homedir, which maps to
// USERPROFILE on Windows and HOME on POSIX, so tests need to override both.
export function installNativeChatTestHome(root: string): () => void {
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  process.env.HOME = root
  process.env.USERPROFILE = root
  return () => {
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = previousUserProfile
    }
  }
}
