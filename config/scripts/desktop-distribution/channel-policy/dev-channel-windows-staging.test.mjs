import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '@orca/process-host'

function readWorkflow(name) {
  return parse(
    readFileSync(new URL(`../../../../.github/workflows/${name}`, import.meta.url), 'utf8')
  )
}

const publish = readWorkflow('dev-channel-win-publish.yml')
const publishSteps = publish.jobs['publish-win'].steps
const directory = mkdtempSync(join(tmpdir(), 'dev-channel-windows-staging-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function runScript(script, { cwd = directory, env = {} } = {}) {
  return runProcess({ program: 'bash', args: ['-c', script], cwd, env: { ...process.env, ...env } })
}

describe('Windows dev-channel artifact staging', () => {
  it('rejects an empty staged installer before publication', async () => {
    const step = publishSteps.find((entry) => entry.name === 'Validate staged Windows artifacts')
    const attempt = mkdtempSync(join(directory, 'files-'))
    const folder = 'staged-windows'
    mkdirSync(join(attempt, folder))
    for (const file of [
      'orca-windows-setup.exe',
      'orca-windows-setup.exe.blockmap',
      'latest.yml'
    ]) {
      writeFileSync(join(attempt, folder, file), 'artifact')
    }
    const installer = join(attempt, folder, 'orca-windows-setup.exe')
    writeFileSync(installer, '')
    expect((await runScript(step.run, { cwd: attempt })).code).toBe(1)
    writeFileSync(installer, 'artifact')
    expect((await runScript(step.run, { cwd: attempt })).code).toBe(0)
  })

  it('validates the channel/tag before downloading artifacts or minting a token', async () => {
    const step = publishSteps[0]
    for (const [channel, tag, code] of [
      ['adhoc', 'v1.4.232-adhoc.20261020052302', 0],
      ['daily', 'v1.4.232-daily.20261020052302', 0],
      ['hourly', 'v1.4.232-hourly.20261020052302', 0],
      ['stable', 'v1.4.232-stable.20261020052302', 1],
      ['adhoc', 'v1.4.232-daily.20261020052302', 1],
      ['adhoc', '--help', 1],
      ['adhoc', '$(exit 99)', 1]
    ]) {
      expect((await runScript(step.run, { env: { CHANNEL: channel, TAG: tag } })).code).toBe(code)
    }
  })
})
