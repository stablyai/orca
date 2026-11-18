import { describe, expect, it } from 'vitest'
import { nodeSetupTranscriptLines, parseNodeSetupLogProgress } from './zotz-node-setup-log-progress'

const TRANSCRIPT = [
  '﻿**********************',
  'Inicio de la transcripción de Windows PowerShell',
  'Id. de proceso: 25340',
  '**********************',
  '[zotz] == power ==',
  '[zotz] power -> done: AC: sleep never',
  '[zotz] == windowsUpdate ==',
  '[zotz] windowsUpdate -> skipped: already set',
  '[zotz] == ssh ==',
  '[zotz] installing OpenSSH Server (this can take a few minutes)',
  ''
].join('\r\n')

describe('node setup transcript progress', () => {
  it('reads settled, running and pending steps from the live transcript', () => {
    expect(
      parseNodeSetupLogProgress(TRANSCRIPT, ['power', 'windowsUpdate', 'ssh', 'firewall'])
    ).toEqual([
      { id: 'power', status: 'done', detail: 'AC: sleep never' },
      { id: 'windowsUpdate', status: 'skipped', detail: 'already set' },
      {
        id: 'ssh',
        status: 'running',
        detail: 'installing OpenSSH Server (this can take a few minutes)'
      },
      { id: 'firewall', status: 'pending' }
    ])
  })

  it('shows only the script output, without the transcript banner', () => {
    expect(nodeSetupTranscriptLines(TRANSCRIPT)).toEqual([
      '== power ==',
      'power -> done: AC: sleep never',
      '== windowsUpdate ==',
      'windowsUpdate -> skipped: already set',
      '== ssh ==',
      'installing OpenSSH Server (this can take a few minutes)'
    ])
  })
})
