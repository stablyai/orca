import { inspectPackageManagerSetupCandidate } from '../../shared/workspace-setup/setup-script-package-manager-suggestion'

export type RepoToolRequirement = {
  command: string
  /** Repo file that implies the tool, shown so the user can see why it is required. */
  reason: string
}

type RepoFileRead = (relativePath: string) => Promise<string | null>
type RepoFileExists = (relativePath: string) => Promise<boolean>

const MARKER_TOOLS: readonly { file: string; command: string }[] = [
  { file: 'Cargo.toml', command: 'cargo' },
  { file: 'go.mod', command: 'go' },
  { file: 'uv.lock', command: 'uv' },
  { file: 'Gemfile', command: 'bundle' }
]

const PYTHON_MARKERS = ['pyproject.toml', 'requirements.txt'] as const

/** CLIs the repo's own manifests imply; git is checked separately because every check needs it. */
export async function inferRepoToolRequirements(
  readFile: RepoFileRead,
  fileExists: RepoFileExists,
  platform: NodeJS.Platform = process.platform
): Promise<RepoToolRequirement[]> {
  const requirements: RepoToolRequirement[] = []
  const add = (command: string, reason: string): void => {
    if (!requirements.some((entry) => entry.command === command)) {
      requirements.push({ command, reason })
    }
  }

  const packageManager = await inspectPackageManagerSetupCandidate(readFile, fileExists)
  if (packageManager) {
    const manager = packageManager.setup.split(/\s+/)[0]
    const reason = packageManager.files[0] ?? 'package.json'
    // Bun runs package scripts itself; every other manager needs Node.
    if (manager !== 'bun') {
      add('node', 'package.json')
    }
    if (manager) {
      add(manager, reason)
    }
  }
  for (const marker of MARKER_TOOLS) {
    if (await fileExists(marker.file)) {
      add(marker.command, marker.file)
    }
  }
  // uv brings its own interpreter, so a uv project needs only uv.
  const usesUv = requirements.some((entry) => entry.command === 'uv')
  for (const marker of usesUv ? [] : PYTHON_MARKERS) {
    if (await fileExists(marker)) {
      // Windows installs `python`; POSIX images ship `python3`.
      add(platform === 'win32' ? 'python' : 'python3', marker)
      break
    }
  }
  return requirements
}
