import { join } from 'node:path'

// Why: herdr daemon persistence resolves its data dir from the home dir via
// getHerdrDataDir(). Tests isolate with a scratch HOME; HERDR_DATA_DIR is the
// test-only override so the daemon never reads or writes a real user's
// ~/.local/share/herdr under parallel test workers.
export function herdrTestDataDir(homeDir: string): string {
  return join(homeDir, '.local', 'share', 'herdr')
}

export function setHerdrTestDataDir(homeDir: string): void {
  process.env.HERDR_DATA_DIR = herdrTestDataDir(homeDir)
}

export function restoreHerdrTestDataDir(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.HERDR_DATA_DIR
  } else {
    process.env.HERDR_DATA_DIR = previous
  }
}
