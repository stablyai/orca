import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomCssSnapshot } from '../../shared/custom-css'
import { CustomCssService } from './custom-css-service'

describe('CustomCssService', () => {
  let home: string
  let service: CustomCssService
  let onChanged: ReturnType<typeof vi.fn<(snapshot: CustomCssSnapshot) => void>>

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-custom-css-service-'))
    onChanged = vi.fn<(snapshot: CustomCssSnapshot) => void>()
    service = new CustomCssService({ homePath: home, onChanged })
  })

  afterEach(() => {
    service.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  it('pushes the new contents after an in-place save', async () => {
    service.ensureFile()
    writeFileSync(service.getPath(), '.dark { --background: #1e1e2e; }')
    await vi.waitFor(() =>
      expect(onChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ css: '.dark { --background: #1e1e2e; }' })
      )
    )
  })

  it('keeps following the file when an editor saves by renaming over it', async () => {
    service.ensureFile()
    const temp = join(home, '.orca', 'custom.css.tmp')
    writeFileSync(temp, ':root { --sidebar: #181825; }')
    renameSync(temp, service.getPath())
    await vi.waitFor(() =>
      expect(onChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ css: ':root { --sidebar: #181825; }' })
      )
    )
  })

  it('stops reporting changes once disposed', async () => {
    service.ensureFile()
    service.dispose()
    writeFileSync(service.getPath(), ':root { --muted: #313244; }')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('picks up a file created by hand after the setting was enabled', async () => {
    service.getSnapshot()
    writeFileSync(service.getPath(), ':root { --border: #313244; }')
    await vi.waitFor(() =>
      expect(onChanged).toHaveBeenLastCalledWith(
        expect.objectContaining({ exists: true, css: ':root { --border: #313244; }' })
      )
    )
  })
})
