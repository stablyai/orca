import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readMobileTasksSourceFamily } from './mobile-tasks-source-family.test-support'

const tasksSource = readMobileTasksSourceFamily()
const hostOperationsSource = readFileSync(
  new URL('./use-mobile-tasks-host-operations.tsx', import.meta.url),
  'utf8'
)
const copyFeedbackSource = readFileSync(
  new URL('./use-mobile-task-copy-feedback.ts', import.meta.url),
  'utf8'
)

describe('mobile tasks device operations', () => {
  it('keeps the existing presentation behind an injectable native boundary', () => {
    // The screen takes its native capabilities as props; the default is resolved once.
    expect(tasksSource).toContain('MobileTasksScreen(props: MobileTasksScreenProps = {})')
    expect(hostOperationsSource).toContain('deviceOperations = defaultHostTaskDeviceOperations()')
    expect(tasksSource).toContain('useMobileTaskCopyFeedback({')
    expect(copyFeedbackSource).toContain('operations.copyText(')
    expect(tasksSource).toContain('deviceOperations.hapticMediumImpact()')
    expect(tasksSource).toContain('deviceOperations.openExternalUrl(')
    // No native module reaches the composition; only the adapters may import them.
    expect(tasksSource).not.toContain("from 'expo-clipboard'")
    expect(tasksSource).not.toContain('Linking.openURL')
    expect(tasksSource).not.toContain("from '../platform/haptics'")
    expect(tasksSource).not.toContain("from '../../../src/platform/haptics'")
  })
})
