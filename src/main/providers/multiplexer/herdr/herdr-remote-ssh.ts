import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { SshTarget } from '../../../../shared/ssh-types'
import {
  buildSshArgs,
  findSystemSsh,
  getOrcaControlSocketPath
} from '../../../ssh/ssh-system-fallback'
import type { SystemSshResolvedConfig } from '../../../ssh/ssh-control-socket'
import { isOpenSshConfigBackedTarget } from '../../../ssh/system-ssh-args'

export type HerdrRemoteSshLaunch = {
  dest: string
  env: { HERDR_CONFIG_PATH: string; PATH: string }
  joinControlPath: string | null
  sshArgs: string[]
  sshBinary: string
}

export function herdrRemoteDest(target: SshTarget): string {
  if (isOpenSshConfigBackedTarget(target) && target.configHost) {
    return target.configHost
  }
  const host = target.configHost || target.host
  return target.username ? `${target.username}@${host}` : host
}

export function herdrRemoteSshArgs(
  target: SshTarget,
  resolvedConfig?: Partial<SystemSshResolvedConfig> | null
): { dest: string; joinControlPath: string | null; sshArgs: string[] } {
  const dest = herdrRemoteDest(target)
  const controlPath = getOrcaControlSocketPath(target, {
    resolvedConfig: resolvedConfig as SystemSshResolvedConfig | null | undefined
  })
  const built = buildSshArgs(target, {
    resolvedConfig: resolvedConfig as SystemSshResolvedConfig | null | undefined
  })
  const destIndex = built.lastIndexOf('--')
  const prefix = destIndex === -1 ? built : built.slice(0, destIndex)
  const sshArgs = rewriteSshArgsForHerdrRemote(prefix, controlPath)
  return { dest, joinControlPath: controlPath, sshArgs }
}

function rewriteSshArgsForHerdrRemote(args: string[], controlPath: string | null): string[] {
  const next: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const value = args[index + 1]
    if (arg === '-o' && value === 'ControlMaster=auto') {
      next.push('-o', controlPath ? 'ControlMaster=no' : 'ControlMaster=auto')
      index += 1
      continue
    }
    if (arg === '-o' && value?.startsWith('ControlPersist=')) {
      index += 1
      continue
    }
    next.push(arg)
  }
  return next
}

export function writeHerdrRemoteSshLaunch(args: {
  target: SshTarget
  resolvedConfig?: Partial<SystemSshResolvedConfig> | null
  sshBinary?: string
}): HerdrRemoteSshLaunch {
  const sshBinary = args.sshBinary ?? findSystemSsh()
  if (!sshBinary) {
    throw new Error('System ssh is not available for herdr --remote')
  }
  const { dest, joinControlPath, sshArgs } = herdrRemoteSshArgs(args.target, args.resolvedConfig)
  const dir = join(tmpdir(), 'orca-herdr-remote', sanitizeDirName(args.target.id || dest))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.toml'), '[remote]\nmanage_ssh_config = false\n')
  writeSshShim(dir, sshBinary, sshArgs)
  return {
    dest,
    env: {
      HERDR_CONFIG_PATH: join(dir, 'config.toml'),
      PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`
    },
    joinControlPath,
    sshArgs,
    sshBinary
  }
}

export function herdrRemoteCommandEnv(
  launch: HerdrRemoteSshLaunch,
  extra?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: launch.env.PATH,
    HERDR_CONFIG_PATH: launch.env.HERDR_CONFIG_PATH,
    ...extra
  }
}

function writeSshShim(dir: string, sshBinary: string, sshArgs: string[]): void {
  if (process.platform === 'win32') {
    const lines = [
      '@echo off',
      `set "ORCA_HERDR_SSH=${escapeCmd(sshBinary)}"`,
      `"%ORCA_HERDR_SSH%" ${sshArgs.map(escapeCmd).join(' ')} %*`
    ]
    writeFileSync(join(dir, 'ssh.cmd'), `${lines.join('\r\n')}\r\n`)
    return
  }
  const quoted = [sshBinary, ...sshArgs].map(posixShellQuote).join(' ')
  writeFileSync(join(dir, 'ssh'), `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 })
}

function sanitizeDirName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'host'
}

function posixShellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function escapeCmd(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}
