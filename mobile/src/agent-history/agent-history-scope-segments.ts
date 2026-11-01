import type { AiVaultScope } from '../../../src/shared/ai-vault-types'
import type { Translate } from '../i18n/mobile-i18n'
import type { MobileSegment } from '../components/MobileSegmentedControl'

export function scopeSegments(t: Translate): MobileSegment<AiVaultScope>[] {
  return [
    { value: 'workspace', label: t('agentHistory.panel.workspace', 'Workspace') },
    { value: 'project', label: t('agentHistory.panel.project', 'Project') },
    { value: 'all', label: t('agentHistory.panel.all', 'All') }
  ]
}
