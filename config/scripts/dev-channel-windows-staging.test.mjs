import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '@orca/process-host'

function readWorkflow(name) {
  return parse(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8'))
}

const build = readWorkflow('dev-channel-win-build.yml')
const publish = readWorkflow('dev-channel-win-publish.yml')
const buildSteps = build.jobs['build-win'].steps
const publishSteps = publish.jobs['publish-win'].steps
const directory = mkdtempSync(join(tmpdir(), 'dev-channel-windows-staging-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function runScript(script, { cwd = directory, env = {} } = {}) {
  return runProcess({ program: 'bash', args: ['-c', script], cwd, env: { ...process.env, ...env } })
}

describe('Windows dev-channel artifact staging', () => {
  it('keeps existing callers publishing by default', () => {
    expect(build.on.workflow_call.inputs.stage_only).toMatchObject({
      type: 'boolean',
      default: false,
      required: false
    })
    expect(build.on.workflow_dispatch.inputs.stage_only).toBeUndefined()
    const normalPackage = buildSteps.find((step) => step.name === 'Publish Windows artifacts')
    expect(normalPackage.with.command).toContain('--publish always')
    expect(normalPackage.if).toBe('${{ !inputs.stage_only }}')
  })

  it('never mints or consumes release-write credentials while staging', () => {
    for (const step of buildSteps) {
      const credentialed = JSON.stringify(step).includes('secrets.') || step.env?.GH_TOKEN
      if (credentialed) {
        expect(step.if, step.name).toBe('${{ !inputs.stage_only }}')
      }
    }
    const stagePackage = buildSteps.find(
      (step) => step.name === 'Package Windows artifacts without publishing'
    )
    expect(stagePackage.if).toBe('inputs.stage_only')
    expect(stagePackage.with.command).toContain('--publish never')
    expect(stagePackage.env.GH_TOKEN).toBeUndefined()
    for (const workflow of [build, publish]) {
      const contents = JSON.stringify(workflow.jobs)
      expect(contents).not.toMatch(/SignPath|SIGNPATH|signpath/)
    }
  })

  it('passes exactly the installer, blockmap, and update manifest within the same run', () => {
    const upload = buildSteps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))
    const download = publishSteps.find((step) =>
      step.uses?.startsWith('actions/download-artifact@')
    )
    expect(upload.if).toBe('inputs.stage_only')
    expect(upload.with.path.trim().split('\n')).toEqual([
      'dist/orca-windows-setup.exe',
      'dist/orca-windows-setup.exe.blockmap',
      'dist/latest.yml'
    ])
    expect(upload.with['if-no-files-found']).toBe('error')
    expect(download.with).toEqual({
      name: upload.with.name,
      path: 'staged-windows'
    })
    expect(build.concurrency.group).not.toBe(publish.concurrency.group)
  })

  it.each([
    ['build', buildSteps, 'dist'],
    ['publish', publishSteps, 'staged-windows']
  ])('fails %s on any missing or empty staged file', async (_name, steps, folder) => {
    const step = steps.find((entry) => entry.name === 'Validate staged Windows artifacts')
    const attempt = mkdtempSync(join(directory, 'files-'))
    mkdirSync(join(attempt, folder))
    expect((await runScript(step.run, { cwd: attempt })).code).toBe(1)
    for (const file of [
      'orca-windows-setup.exe',
      'orca-windows-setup.exe.blockmap',
      'latest.yml'
    ]) {
      writeFileSync(join(attempt, folder, file), '')
      expect((await runScript(step.run, { cwd: attempt })).code).toBe(1)
      writeFileSync(join(attempt, folder, file), 'artifact')
    }
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

  it('requires a live existing release and never creates one', async () => {
    const guard = publishSteps.find((step) => step.name === 'Confirm the target release is live')
    for (const [response, code] of [
      ['false', 0],
      ['true', 1],
      ['', 1]
    ]) {
      const stub = 'gh() { printf "%s" "$STUB_RESPONSE"; }; export -f gh;\n'
      expect(
        (
          await runScript(`${stub}${guard.run}`, {
            env: { STUB_RESPONSE: response, CHANNEL: 'adhoc', TAG: 'v1.4.232-adhoc.1' }
          })
        ).code
      ).toBe(code)
    }
    expect(
      (
        await runScript(`gh() { return 1; };\n${guard.run}`, {
          env: { CHANNEL: 'adhoc', TAG: 'v1.4.232-adhoc.1' }
        })
      ).code
    ).toBe(1)
    const upload = publishSteps.find((step) => step.name === 'Publish Windows artifacts')
    expect(upload.with.command).toContain('gh release upload')
    expect(JSON.stringify(publish)).not.toContain('gh release create')
    expect(publishSteps.indexOf(guard)).toBeLessThan(publishSteps.indexOf(upload))
  })
})
