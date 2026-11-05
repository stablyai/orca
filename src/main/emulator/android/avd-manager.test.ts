import { describe, expect, it } from 'vitest'
import { parseAvdList } from './avd-manager'

describe('parseAvdList', () => {
  it('keeps AVD names while dropping blank and informational lines', () => {
    const stdout = ['Pixel_7', '', 'INFO | Storing crashdata in: /tmp/avd', 'Pixel_Tablet'].join(
      '\n'
    )
    expect(parseAvdList(stdout)).toEqual(['Pixel_7', 'Pixel_Tablet'])
  })

  it('drops WARNING, ERROR and "No AVD" lines', () => {
    const stdout = [
      'WARNING | no metrics',
      'Pixel_7',
      'ERROR | bad config',
      'No AVD found in /home/user/.android/avd'
    ].join('\n')
    expect(parseAvdList(stdout)).toEqual(['Pixel_7'])
  })
})
