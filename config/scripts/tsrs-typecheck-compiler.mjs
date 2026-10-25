import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'

export function supportsTsrs(platform = process.platform, arch = process.arch) {
  return (
    (platform === 'darwin' && arch === 'arm64') ||
    (platform === 'linux' && (arch === 'arm64' || arch === 'x64'))
  )
}

export function resolveTsrsLauncher(root) {
  let manifestPath
  try {
    manifestPath = createRequire(join(root, 'package.json')).resolve('tsrs/package.json')
  } catch (cause) {
    throw new Error('Local tsrs compiler is missing; run pnpm install, or pass --compiler=bun.', {
      cause
    })
  }
  const { bin, version } = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return { launcher: join(dirname(manifestPath), bin.tsrs), version }
}

export function resolveTsrsTypecheckCommand(config, root, { checkers } = {}) {
  const { launcher, version } = resolveTsrsLauncher(root)
  const project = relative(root, resolve(root, config))
  const identity = createHash('sha256').update(project).digest('hex').slice(0, 12)
  const cacheDirectory = join(root, '.cache', 'typecheck', 'tsrs', version)
  mkdirSync(cacheDirectory, { recursive: true })
  return {
    program: process.execPath,
    args: [
      launcher,
      '--noEmit',
      '-p',
      config,
      '--composite',
      'false',
      '--incremental',
      'true',
      '--tsBuildInfoFile',
      join(cacheDirectory, `${basename(config, '.json')}-${identity}.tsbuildinfo`),
      ...(checkers === undefined ? [] : ['--checkers', String(checkers)])
    ],
    cwd: root
  }
}
