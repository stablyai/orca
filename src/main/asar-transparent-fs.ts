// Why: Electron patches `fs` so a `*.asar` file reports `isDirectory() === true`, so Node's
// recursive `rm` descends into the archive, tries to `rmdir` a real file, and fails the parent with
// ENOTEMPTY. Every worktree that has ever run `pnpm install` carries at least one
// (`node_modules/.pnpm/electron@…/…/Electron.app/Contents/Resources/default_app.asar`), so a
// worktree removal aborts there deterministically — the residue is not a concurrent-writer race and
// no amount of retrying clears it. `original-fs` is Electron's unpatched `fs`; unlike
// `process.noAsar` it is scoped to this call rather than to the whole process, which matters because
// a multi-GB removal runs for seconds while the main process may still be loading modules out of
// `app.asar`. See `cli/appimage-payload-removal.ts` for the same bug at a call site short enough to
// use the process-global flag.

import { rm as nodeRm } from 'node:fs/promises'
import { createRequire } from 'node:module'

type Rm = typeof nodeRm

let resolvedRm: Rm | undefined

function resolveRm(): Rm {
  try {
    // Why require and not an import: `original-fs` only exists inside Electron, so vitest, the
    // `orca` CLI and the plain-node entrypoints must resolve `node:fs/promises` instead — and there
    // the shim does not exist either, so plain `fs` is already asar-transparent.
    const originalFs = createRequire(__filename)('original-fs') as { promises?: { rm?: Rm } }
    return typeof originalFs.promises?.rm === 'function' ? originalFs.promises.rm : nodeRm
  } catch {
    return nodeRm
  }
}

/** `fs.promises.rm` that sees a `*.asar` as the file it is rather than as a directory. */
export const rm: Rm = (path, options) => {
  resolvedRm ??= resolveRm()
  return resolvedRm(path, options)
}
