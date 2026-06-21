import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { BrowserDownloadDestinationReservations } from './browser-download-destination'

describe('BrowserDownloadDestinationReservations', () => {
  const downloadsPath = path.join(path.sep, 'Users', 'orca', 'Downloads')

  it('uses the downloads folder and preserves a safe basename', () => {
    const reservations = new BrowserDownloadDestinationReservations({
      downloadsPath,
      pathExists: vi.fn(() => false),
      platform: 'linux'
    })

    expect(reservations.reserve('../nested/report.csv')).toEqual({
      filename: 'report.csv',
      savePath: path.join(downloadsPath, 'report.csv'),
      reservationKey: path.resolve(downloadsPath, 'report.csv')
    })
    expect(reservations.reserve('C:\\Users\\orca\\Downloads\\budget.xlsx').filename).toBe(
      'budget.xlsx'
    )
  })

  it('falls back to download for empty or unsafe filenames', () => {
    const reservations = new BrowserDownloadDestinationReservations({
      downloadsPath,
      pathExists: vi.fn(() => false),
      platform: 'linux'
    })

    expect(reservations.reserve('   ').filename).toBe('download')
    expect(reservations.reserve('...').filename).toBe('download (1)')
    expect(reservations.reserve('bad<name>.txt').filename).toBe('bad_name_.txt')
  })

  it('adds browser-style suffixes without overwriting existing files', () => {
    const existingPaths = new Set([
      path.join(downloadsPath, 'report.csv'),
      path.join(downloadsPath, 'report (1).csv')
    ])
    const reservations = new BrowserDownloadDestinationReservations({
      downloadsPath,
      pathExists: vi.fn((filePath: string) => existingPaths.has(filePath)),
      platform: 'linux'
    })

    expect(reservations.reserve('report.csv').filename).toBe('report (2).csv')
  })

  it('reserves simultaneous same-name downloads before files exist', () => {
    const reservations = new BrowserDownloadDestinationReservations({
      downloadsPath,
      pathExists: vi.fn(() => false),
      platform: 'linux'
    })

    const first = reservations.reserve('report.csv')
    const second = reservations.reserve('report.csv')

    expect(first.filename).toBe('report.csv')
    expect(second.filename).toBe('report (1).csv')

    reservations.release(first.reservationKey)

    expect(reservations.reserve('report.csv').filename).toBe('report.csv')
  })

  it('uses case-insensitive path identity on Windows and macOS', () => {
    const windowsReservations = new BrowserDownloadDestinationReservations({
      downloadsPath: 'C:\\Users\\orca\\Downloads',
      pathExists: vi.fn(() => false),
      platform: 'win32'
    })
    const macReservations = new BrowserDownloadDestinationReservations({
      downloadsPath,
      pathExists: vi.fn(() => false),
      platform: 'darwin'
    })

    expect(windowsReservations.reserve('Report.csv').filename).toBe('Report.csv')
    expect(windowsReservations.reserve('report.csv').filename).toBe('report (1).csv')
    expect(macReservations.reserve('Report.csv').filename).toBe('Report.csv')
    expect(macReservations.reserve('report.csv').filename).toBe('report (1).csv')
  })

  it('fails after bounded collision attempts', () => {
    const reservations = new BrowserDownloadDestinationReservations({
      downloadsPath,
      pathExists: vi.fn(() => true),
      platform: 'linux'
    })

    expect(() => reservations.reserve('report.csv')).toThrow(
      'Could not choose a unique file name in Downloads.'
    )
  })
})
