import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'

export async function withClaudeRichOutputBuildLock(root, action) {
  mkdirSync(join(root, 'out'), { recursive: true })
  let compromised
  const release = await lockfile.lock(root, {
    lockfilePath: join(root, 'out', '.claude-rich-output-build.lock'),
    realpath: false,
    stale: 30_000,
    retries: { retries: 1_000, minTimeout: 50, maxTimeout: 250 },
    onCompromised: (error) => {
      compromised = error
    }
  })
  const assertLockHeld = () => {
    if (compromised) {
      throw compromised
    }
  }
  try {
    assertLockHeld()
    const result = await action(assertLockHeld)
    assertLockHeld()
    return result
  } finally {
    if (!compromised) {
      await release().catch((error) => {
        console.warn('[claude-rich-output] Could not release build lock:', error)
      })
    }
  }
}
