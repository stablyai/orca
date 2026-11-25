// Which package manager installed an agent CLI, and the command that upgrades that install.

import { readFile, stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { parseWindowsCmdShim } from '@orca/process-host/windows-cmd-shim-resolution'

type NodeGlobalManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

type AgentCliPackageInstall =
  | { manager: 'homebrew'; cask: boolean; name: string }
  | { manager: NodeGlobalManager; name: string }
  | { manager: 'winget'; name: string }

export type AgentCliPackages = {
  homebrew?: readonly string[]
  /** Its global install under npm, pnpm, Yarn or Bun. */
  nodeGlobal?: string
  winget?: string
}

const NODE_GLOBAL_UPGRADE: Record<NodeGlobalManager, string> = {
  npm: 'npm install -g',
  pnpm: 'pnpm add -g',
  yarn: 'yarn global add',
  bun: 'bun add -g'
}

const MAX_SHIM_BYTES = 64 * 1024

/**
 * The file a package manager's launcher script runs: pnpm's POSIX shims name it, and npm's and
 * pnpm's Windows `.cmd` shims spell it relative to themselves. Null for anything else.
 */
export async function packageShimTarget(path: string): Promise<string | null> {
  const isCmd = /\.cmd$/i.test(path)
  try {
    if ((await stat(path)).size > MAX_SHIM_BYTES) {
      return null
    }
    const contents = await readFile(path, 'utf8')
    if (!isCmd) {
      return /^# cmd-shim-target=(\/.+)$/m.exec(contents)?.[1] ?? null
    }
    const shim = parseWindowsCmdShim(contents)
    const target = shim?.kind === 'node' ? shim.script : shim?.target
    return target ? win32.resolve(win32.dirname(path), target) : null
  } catch {
    return null
  }
}

// `modulesParent` is the folder holding the package's node_modules; a project's own copy isn't global.
function nodeGlobalManager(path: string, modulesParent: string): NodeGlobalManager | null {
  if (path.includes('/.bun/install/global/')) {
    return 'bun'
  }
  if (/\/global\/(?:\d+|v\d+\/[^/]+)\/node_modules\//.test(path)) {
    return 'pnpm'
  }
  if (/\/yarn\/(?:data\/)?global\//i.test(path)) {
    return 'yarn'
  }
  // <prefix>/lib/node_modules, or <prefix>/node_modules under Windows' %APPDATA%\npm.
  return /\/(?:lib|npm)$/i.test(modulesParent) ? 'npm' : null
}

function agentCliPackageInstall(installPath: string): AgentCliPackageInstall | null {
  const path = installPath.replaceAll('\\', '/')
  const brew = /\/(Caskroom|Cellar)\/([^/]+)\//.exec(path)
  if (brew) {
    return { manager: 'homebrew', cask: brew[1] === 'Caskroom', name: brew[2] }
  }
  // User scope only, as Claude's own WinGet check reads it.
  const winget = /\/Microsoft\/WinGet\/Packages\/([^/_]+)_/i.exec(path)
  if (winget) {
    return { manager: 'winget', name: winget[1] }
  }
  const node = /^(.*)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path)
  const manager = node ? nodeGlobalManager(path, node[1]) : null
  return node && manager ? { manager, name: node[2] } : null
}

function upgradeCommand(install: AgentCliPackageInstall): string {
  switch (install.manager) {
    case 'homebrew':
      return `brew upgrade ${install.cask ? '--cask ' : ''}${install.name}`
    case 'winget':
      return `winget upgrade ${install.name}`
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return `${NODE_GLOBAL_UPGRADE[install.manager]} ${install.name}@latest`
  }
}

function isAgentPackage(install: AgentCliPackageInstall, packages: AgentCliPackages): boolean {
  switch (install.manager) {
    case 'homebrew':
      return packages.homebrew?.includes(install.name) ?? false
    case 'winget':
      return packages.winget?.toLowerCase() === install.name.toLowerCase()
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return packages.nodeGlobal === install.name
  }
}

// Only the agent's own packages count: a mise or Volta shim on PATH resolves into that manager's keg.
export function packageUpgradeCommand(
  installPath: string,
  packages: AgentCliPackages
): string | null {
  const install = agentCliPackageInstall(installPath)
  return install && isAgentPackage(install, packages) ? upgradeCommand(install) : null
}

export function isHomebrewCask(installPath: string, cask: string): boolean {
  const install = agentCliPackageInstall(installPath)
  return install?.manager === 'homebrew' && install.cask && install.name === cask
}
