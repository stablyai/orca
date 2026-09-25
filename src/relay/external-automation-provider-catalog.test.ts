import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('ExternalAutomationProviderCatalog', () => {
  let hermesHome: string
  let previousHermesHome: string | undefined

  beforeEach(async () => {
    previousHermesHome = process.env.HERMES_HOME
    hermesHome = await mkdtemp(join(tmpdir(), 'relay-hermes-catalog-'))
    process.env.HERMES_HOME = hermesHome
    await mkdir(join(hermesHome, 'cron'), { recursive: true })
    vi.resetModules()
  })

  afterEach(async () => {
    if (previousHermesHome === undefined) {
      delete process.env.HERMES_HOME
    } else {
      process.env.HERMES_HOME = previousHermesHome
    }
    await rm(hermesHome, { recursive: true, force: true })
    vi.resetModules()
  })

  it('returns readable jobs when the remote CLI is unavailable', async () => {
    await writeFile(
      join(hermesHome, 'cron', 'jobs.json'),
      JSON.stringify({ jobs: [{ id: 'job-1', name: 'Monitor' }] }),
      'utf-8'
    )
    const { ExternalAutomationProviderCatalog } =
      await import('./external-automation-provider-catalog')
    const catalog = new ExternalAutomationProviderCatalog(
      vi.fn().mockRejectedValue(new Error('not found')),
      vi.fn().mockResolvedValue({ total: 3, runs: [] })
    )

    await expect(catalog.listJobs({ provider: 'hermes' })).resolves.toEqual({
      jobs: [{ id: 'job-1', name: 'Monitor', run_count: 3, runs: [] }],
      hermesAvailable: false,
      openclawAvailable: false,
      error: null
    })
  })

  it('projects jobs-file parse failures without hiding command availability', async () => {
    await writeFile(join(hermesHome, 'cron', 'jobs.json'), '{not-json', 'utf-8')
    const { ExternalAutomationProviderCatalog } =
      await import('./external-automation-provider-catalog')
    const catalog = new ExternalAutomationProviderCatalog(
      vi.fn().mockResolvedValue(undefined),
      vi.fn()
    )

    const result = await catalog.listJobs({ provider: 'hermes' })

    expect(result.jobs).toEqual([])
    expect(result.hermesAvailable).toBe(true)
    expect(result.openclawAvailable).toBe(false)
    expect(result.error).toMatch(/^SyntaxError:/)
  })

  it('preserves all-or-nothing Hermes count enrichment failures', async () => {
    await writeFile(
      join(hermesHome, 'cron', 'jobs.json'),
      JSON.stringify([{ id: 'job-1' }, { id: '--invalid' }]),
      'utf-8'
    )
    const { ExternalAutomationProviderCatalog } =
      await import('./external-automation-provider-catalog')
    const catalog = new ExternalAutomationProviderCatalog(
      vi.fn().mockResolvedValue(undefined),
      vi
        .fn()
        .mockResolvedValueOnce({ total: 1, runs: [] })
        .mockRejectedValueOnce(new Error('Invalid external automation job ID.'))
    )

    const result = await catalog.listJobs({ provider: 'hermes' })

    expect(result.jobs).toEqual([])
    expect(result.error).toBe('Error: Invalid external automation job ID.')
  })
})
