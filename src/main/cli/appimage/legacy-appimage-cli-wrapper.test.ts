import { describe, expect, it } from 'vitest'
import {
  buildLegacyAppImageCliWrapper,
  extractLegacyAppImageCliWrapperTarget
} from './legacy-appimage-cli-wrapper'

describe('legacy AppImage CLI wrapper', () => {
  it('rejects a wrapper with a changed command body', () => {
    const wrapper = buildLegacyAppImageCliWrapper('/tmp/Orca.AppImage')
    expect(
      extractLegacyAppImageCliWrapperTarget(wrapper.replace('set -euo pipefail', 'set -u'))
    ).toBe(null)
  })
})
