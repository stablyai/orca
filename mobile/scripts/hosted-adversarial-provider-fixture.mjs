import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const fixturePrefix = 'orca-mobile-provider.'
const providerRemote = 'https://github.com/orca-e2e/adversarial.git'

export const HOSTED_ADVERSARIAL_PROVIDER_MARKER = 'ORCA_ADVERSARIAL_PROVIDER'
export const HOSTED_ADVERSARIAL_PROVIDER_TITLE_MARKER = 'ORCA_ADVERSARIAL_PROVIDER_TITLE'
export const HOSTED_ADVERSARIAL_PROVIDER_ERROR_MARKER = 'ORCA_ADVERSARIAL_PROVIDER_ERROR'
export const HOSTED_ADVERSARIAL_MERMAID_MARKER = 'ORCA_ADVERSARIAL_MERMAID'

export async function createHostedAdversarialProviderFixture({
  probePort,
  repositoryRoot,
  scriptDirectory = import.meta.dirname
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), fixturePrefix))
  try {
    const headOid = await git(repositoryRoot, ['rev-parse', 'HEAD'])
    const baseOid = await git(repositoryRoot, ['rev-parse', 'HEAD^']).catch(() => headOid)
    const branch = await git(repositoryRoot, ['branch', '--show-current'])
    await git(repositoryRoot, ['remote', 'add', 'origin', providerRemote])
    const bin = path.join(root, 'bin')
    await writeFile(path.join(root, 'calls.jsonl'), '')
    await writeFile(
      path.join(root, 'fixture.json'),
      `${JSON.stringify(
        providerFixtureConfig({ baseOid, branch, headOid, probePort, root }),
        null,
        2
      )}\n`
    )
    await mkdir(bin, { recursive: true, mode: 0o700 })
    const cli = path.join(scriptDirectory, 'hosted-adversarial-github-cli.mjs')
    const posixShim = path.join(bin, 'gh')
    await writeFile(posixShim, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, {
      mode: 0o700
    })
    await chmod(posixShim, 0o700)
    await writeFile(path.join(bin, 'gh.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`)
    return {
      root,
      configPath: path.join(root, 'fixture.json'),
      logPath: path.join(root, 'calls.jsonl'),
      environment: {
        ORCA_E2E_GITHUB_FIXTURE_PATH: path.join(root, 'fixture.json'),
        PATH: [bin, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter)
      }
    }
  } catch (error) {
    await git(repositoryRoot, ['remote', 'remove', 'origin']).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export async function removeHostedAdversarialProviderFixture(fixture, repositoryRoot) {
  if (!fixture?.root || !path.basename(fixture.root).startsWith(fixturePrefix)) {
    throw new Error('Refusing to remove an invalid adversarial provider fixture')
  }
  await git(repositoryRoot, ['remote', 'remove', 'origin']).catch(() => undefined)
  await rm(fixture.root, { recursive: true, force: true })
}

export async function readHostedAdversarialProviderCalls(fixture) {
  return (await readFile(fixture.logPath, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function providerFixtureConfig({ baseOid, branch, headOid, probePort, root }) {
  const titlePayload = `<img src=x onerror="globalThis.${HOSTED_ADVERSARIAL_PROVIDER_TITLE_MARKER}=1">`
  const bodyPayload = `<img src=x onerror="globalThis.${HOSTED_ADVERSARIAL_PROVIDER_MARKER}=1">`
  const mermaidProbe = `http://127.0.0.1:${probePort ?? 9}/mermaid-${HOSTED_ADVERSARIAL_MERMAID_MARKER}`
  return {
    baseOid,
    branch,
    headOid,
    logPath: path.join(root, 'calls.jsonl'),
    updatedAt: '2026-07-29T00:00:00Z',
    title: `${HOSTED_ADVERSARIAL_PROVIDER_TITLE_MARKER} ${titlePayload}`,
    body: `\`${HOSTED_ADVERSARIAL_PROVIDER_MARKER}\`\n\n${bodyPayload}`,
    comment: `\`${HOSTED_ADVERSARIAL_MERMAID_MARKER}\`

\`\`\`mermaid
graph TD
  Start --> Parse --> Sanitize --> Render --> Verify --> Done
  click Start "${mermaidProbe}"
\`\`\``,
    error:
      `${HOSTED_ADVERSARIAL_PROVIDER_ERROR_MARKER}: <img src=x onerror="globalThis.${HOSTED_ADVERSARIAL_PROVIDER_ERROR_MARKER}=1"> ${'bounded '.repeat(48)}`.trim()
  }
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000
  })
  return stdout.trim()
}
