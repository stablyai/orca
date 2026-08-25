import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export type TrustedPiRpcCliInvocation = {
  executable: string
  argsPrefix: [string]
  env: { ELECTRON_RUN_AS_NODE: '1' }
}

export function resolveTrustedPiRpcCliInvocation(args: {
  executablePath: string
  cliEntryPath: string
  workspacePath: string
}): TrustedPiRpcCliInvocation {
  const workspace = canonicalRegularDirectory(args.workspacePath)
  const executable = canonicalRegularFile(args.executablePath, workspace, true)
  const cliEntry = canonicalRegularFile(args.cliEntryPath, workspace, false)
  return {
    executable,
    argsPrefix: [cliEntry],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

function canonicalRegularDirectory(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error('pi_rpc_worker_cli_invocation_untrusted')
  }
  const canonical = realpathSync.native(path)
  const info = statSync(canonical)
  if (!info.isDirectory()) {
    throw new Error('pi_rpc_worker_cli_invocation_untrusted')
  }
  return canonical
}

function canonicalRegularFile(path: string, workspace: string, executable: boolean): string {
  if (!isAbsolute(path)) {
    throw new Error('pi_rpc_worker_cli_invocation_untrusted')
  }
  const lexical = resolve(path)
  const canonical = realpathSync.native(lexical)
  if (isWithin(workspace, lexical) || isWithin(workspace, canonical)) {
    throw new Error('pi_rpc_worker_cli_invocation_untrusted')
  }
  const info = statSync(canonical)
  const uid = process.getuid?.()
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    (uid !== undefined && info.uid !== 0 && info.uid !== uid)
  ) {
    throw new Error('pi_rpc_worker_cli_invocation_untrusted')
  }
  if (process.platform !== 'win32') {
    if (executable) {
      accessSync(canonical, constants.X_OK)
    }
    if ((info.mode & 0o022) !== 0) {
      throw new Error('pi_rpc_worker_cli_invocation_untrusted')
    }
  }
  return canonical
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))
}
