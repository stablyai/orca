import { createHash } from 'node:crypto'
import { readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'

async function main() {
  const prefix = '/opt/orca/providers'
  const packages = [
    ['@anthropic-ai/claude-code', 'claude', process.env.CLAUDE_CODE_VERSION],
    ['@openai/codex', 'codex', process.env.CODEX_VERSION],
    ['@google/gemini-cli', 'gemini', process.env.GEMINI_CLI_VERSION]
  ]
  const providers = []
  for (const [name, command, version] of packages) {
    if (!version) {
      continue
    }
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`${name} needs an exact version, received ${version}`)
    }
    const install = await runProcess({
      program: 'npm',
      args: [
        'install',
        '--global',
        '--prefix',
        prefix,
        '--no-audit',
        '--no-fund',
        `${name}@${version}`
      ],
      timeoutMs: 300000,
      maxOutputBytes: 256 * 1024
    })
    if (install.code !== 0) {
      throw new Error(`${name} installation failed: ${install.stderr}`)
    }
    const binary = await realpath(join(prefix, 'bin', command))
    const check = await runProcess({ program: binary, args: ['--version'], timeoutMs: 30000 })
    if (check.code !== 0) {
      throw new Error(`${command} --version failed: ${check.stderr}`)
    }
    const pkg = JSON.parse(
      await readFile(join(prefix, 'lib/node_modules', name, 'package.json'), 'utf8')
    )
    if (pkg.name !== name || pkg.version !== version) {
      throw new Error(`${name} package identity differs`)
    }
    providers.push({
      package: name,
      version,
      command,
      binary,
      sha256: createHash('sha256')
        .update(await readFile(binary))
        .digest('hex'),
      reportedVersion: check.stdout.trim()
    })
  }
  await writeFile('/opt/orca/providers/manifest.json', `${JSON.stringify(providers, null, 2)}\n`)
  await rm(join(process.env.HOME, '.npm'), { recursive: true, force: true })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
