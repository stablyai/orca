import { Text } from 'react-native'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import { getProviderDisplayName } from '../../../src/shared/agent-usage/display/usage-provider-windows'
import { hasMobileAgentIcon, MobileAgentIcon } from '../components/icons/MobileAgentIcon'

/** The CLI that spends a provider's quota, whose icon stands for the provider in a tab. */
const USAGE_PROVIDER_LOGO_AGENT: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  'opencode-go': 'opencode',
  kimi: 'kimi',
  antigravity: 'antigravity',
  grok: 'grok',
  cursor: 'cursor',
  minimax: 'minimax',
  zcode: 'zcode',
  muse: 'muse'
}

const USAGE_TAB_LOGO_SIZE = 18

function usageProviderLogoAgent(provider: string): string | null {
  const agent = USAGE_PROVIDER_LOGO_AGENT[provider]
  return agent && hasMobileAgentIcon(agent) ? agent : null
}

/** A provider's logo for a tab, or undefined where it has none and the tab keeps its name. */
export function usageProviderTabLogo(provider: string): React.JSX.Element | undefined {
  const agent = usageProviderLogoAgent(provider)
  return agent ? <MobileAgentIcon agentId={agent} size={USAGE_TAB_LOGO_SIZE} /> : undefined
}

/** A provider's logo at `size`, or its initial where it has none. */
export function UsageProviderGlyph({
  provider,
  size
}: {
  provider: string
  size: number
}): React.JSX.Element {
  const colors = useMobileColors()

  const agent = usageProviderLogoAgent(provider)
  if (agent) {
    return <MobileAgentIcon agentId={agent} size={size} />
  }
  return (
    <Text
      style={{
        fontSize: size * 0.8,
        lineHeight: size,
        fontWeight: '700',
        color: colors.textPrimary
      }}
      allowFontScaling={false}
    >
      {getProviderDisplayName(provider).slice(0, 1)}
    </Text>
  )
}
