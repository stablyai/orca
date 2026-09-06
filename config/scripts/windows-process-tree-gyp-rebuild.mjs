/**
 * Where and how `@vscode/windows-process-tree` is rebuilt from source.
 *
 * node-gyp must run from the package's physical directory, never the
 * `node_modules` symlink/junction pnpm installs there: gyp expands the
 * node-addon-api dependency by probing node (whose cwd resolves to the
 * physical path), gets back a store-relative `../../../../node-addon-api@…`
 * hop, then resolves that hop against the rebuild cwd. From the link path the
 * hop escapes the store and configure fails with "node_addon_api.gyp not
 * found" (run 32999886072).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')

export const WINDOWS_PROCESS_TREE_PACKAGE_DIR = join(
  ROOT,
  'node_modules',
  '@vscode',
  'windows-process-tree'
)

export const WINDOWS_PROCESS_TREE_PATCH_PATH = join(
  ROOT,
  'config',
  'patches',
  '@vscode__windows-process-tree@0.8.0.patch'
)

/** Only the patched reader defines this; the upstream one walks the PEB. */
const COMMAND_LINE_PATCH_MARKER = 'kProcessCommandLineInformation'

export const WINDOWS_PROCESS_TREE_NODE_ADDON_API_HEADERS = [
  'napi.h',
  'napi-inl.h',
  'napi-inl.deprecated.h'
]

export function nodeGypRebuildInvocation(arch, packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR) {
  return {
    args: [
      join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
      'rebuild',
      `--arch=${arch}`
    ],
    cwd: realpathSync(packageDir)
  }
}

/** The binary the addon actually loads. */
export function windowsProcessTreeAddonPath(packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR) {
  return join(packageDir, 'build', 'Release', 'windows_process_tree.node')
}

/** The import whose absence tells the patched binary from the published prebuilt. */
const FLAGGED_IMPORT = 'ReadProcessMemory'

/**
 * Does this compiled addon still carry the flagged primitive?
 *
 * The patched reader never calls `ReadProcessMemory`, so the symbol is absent
 * from its import table; the upstream build imports it. That makes this a
 * property of the binary rather than of the source next to it, which matters
 * because the published tarball ships a *loadable* prebuilt built from
 * unpatched source: it is node-addon-api, so it satisfies a bare `require()`
 * under both Node and Electron, and a skipped rebuild would use it.
 *
 * Tri-state, not a predicate: a binary that is not there has not been cleared,
 * and a boolean makes "absent" indistinguishable from "verified clean" at every
 * call site. Takes the binary path so the relay's staged addon -- which sits
 * beside the bundle, with no package around it -- gets the same check.
 *
 * @param {string} addonPath
 * @returns {'clean' | 'unpatched' | 'missing'}
 */
export function inspectWindowsProcessTreeAddon(addonPath) {
  if (!existsSync(addonPath)) {
    return 'missing'
  }
  return readFileSync(addonPath).includes(FLAGGED_IMPORT) ? 'unpatched' : 'clean'
}

/**
 * Refuse to compile or load the upstream command-line reader.
 *
 * Unpatched, it opens every process with `PROCESS_VM_READ` and walks the PEB to
 * recover the command line -- the primitive MDE scores as credential dumping,
 * and the reason this package is patched at all. pnpm has been seen
 * materializing this CRLF package with its patch missing, so repair the source
 * from the patch file, and drop any binary that predates the repair.
 */
export function ensureWindowsProcessTreeCommandLinePatch(
  packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR
) {
  const source = join(packageDir, 'src', 'process_commandline.cc')
  if (!existsSync(source)) {
    throw new Error(
      `${source} is missing, so the command-line patch cannot be verified. Run pnpm install.`
    )
  }
  let repaired = false

  if (!readFileSync(source, 'utf8').includes(COMMAND_LINE_PATCH_MARKER)) {
    try {
      execFileSync(
        'git',
        [
          // Why force the line-ending mode: the patch is stored LF (a contract
          // test forbids CR bytes in it), but upstream ships this source CRLF,
          // so its pre-image lines and the file's differ by a CR. Under
          // `core.autocrlf=false` -- Git's own built-in default, and what
          // "checkout as-is" selects in the Git for Windows installer -- git
          // compares them literally, the hunk does not match, and the repair
          // throws. `input` normalizes line endings for that comparison and
          // nothing else, so a hunk whose real content drifted is still
          // rejected. Measured: without it, apply exits 1 at autocrlf=false and
          // 0 at true/input; with it, 0 for CRLF and LF sources under all three.
          '-c',
          'core.autocrlf=input',
          'apply',
          '--include=src/process_commandline.cc',
          WINDOWS_PROCESS_TREE_PATCH_PATH
        ],
        {
          cwd: realpathSync(packageDir),
          stdio: 'pipe',
          // Why blind git to the repo: run inside a work tree, `git apply`
          // prefixes patch paths with the cwd-relative prefix, silently skips
          // everything that does not match -- and still exits 0. The package
          // dir is always under the project root, so without this the repair
          // reports success and changes nothing.
          env: { ...process.env, GIT_DIR: join(packageDir, '.orca-no-such-git-dir') }
        }
      )
    } catch (error) {
      throw new Error(
        'src/process_commandline.cc still reads the PEB, and repairing it from ' +
          `${WINDOWS_PROCESS_TREE_PATCH_PATH} failed: ${error?.message ?? error}. Run pnpm install.`
      )
    }
    if (!readFileSync(source, 'utf8').includes(COMMAND_LINE_PATCH_MARKER)) {
      throw new Error(
        'src/process_commandline.cc still reads the PEB after repair, so the patch did not ' +
          'apply. Run pnpm install.'
      )
    }
    repaired = true
  }

  // A binary from before the repair -- or the tarball's own prebuilt -- would
  // otherwise survive a skipped rebuild and load the flagged reader anyway.
  // Deleting it can fail EPERM against a loaded (memory-mapped) addon, which
  // `force: true` does not cover -- it only swallows ENOENT. That throw is the
  // caller's to classify as a Windows file lock, so it must not be swallowed.
  if (inspectWindowsProcessTreeAddon(windowsProcessTreeAddonPath(packageDir)) === 'unpatched') {
    rmSync(windowsProcessTreeAddonPath(packageDir), { force: true })
    repaired = true
  }

  return repaired
}

// Patched binding.gyp includes deps/node-addon-api; the tarball does not ship those headers.
export function stageWindowsProcessTreeNodeAddonApiHeaders(
  packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR
) {
  const nodeAddonApiDir = dirname(
    createRequire(join(packageDir, 'package.json')).resolve('node-addon-api/package.json')
  )
  const stagedHeaderDir = join(packageDir, 'deps', 'node-addon-api')
  mkdirSync(stagedHeaderDir, { recursive: true })
  for (const header of WINDOWS_PROCESS_TREE_NODE_ADDON_API_HEADERS) {
    copyFileSync(join(nodeAddonApiDir, header), join(stagedHeaderDir, header))
  }
  return stagedHeaderDir
}
