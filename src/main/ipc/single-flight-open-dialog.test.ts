import { beforeEach, describe, expect, it, vi } from 'vitest'

const { showOpenDialogMock } = vi.hoisted(() => ({
  showOpenDialogMock: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: showOpenDialogMock }
}))

import { showSingleFlightOpenDialog } from './single-flight-open-dialog'

describe('showSingleFlightOpenDialog', () => {
  beforeEach(() => {
    showOpenDialogMock.mockReset()
  })

  it('opens only one native picker while one is already showing', async () => {
    let resolveFirst: (value: { canceled: boolean; filePaths: string[] }) => void = () => {}
    showOpenDialogMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve
      })
    )

    const first = showSingleFlightOpenDialog({ properties: ['openDirectory'] })
    const second = await showSingleFlightOpenDialog({
      properties: ['openDirectory']
    })

    expect(second).toEqual({ canceled: true, filePaths: [] })
    expect(showOpenDialogMock).toHaveBeenCalledTimes(1)

    resolveFirst({ canceled: false, filePaths: ['/repo'] })
    await expect(first).resolves.toEqual({
      canceled: false,
      filePaths: ['/repo']
    })
  })

  it('allows a new picker after the previous one closes or fails', async () => {
    showOpenDialogMock.mockRejectedValueOnce(new Error('boom'))
    await expect(showSingleFlightOpenDialog({ properties: ['openFile'] })).rejects.toThrow('boom')

    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/a']
    })
    await expect(showSingleFlightOpenDialog({ properties: ['openFile'] })).resolves.toEqual({
      canceled: false,
      filePaths: ['/a']
    })
  })
})
