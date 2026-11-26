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

/** A provider's logo for a tab, or undefined where it has none and the tab keeps its name. */
export function usageProviderTabLogo(provider: string): React.JSX.Element | undefined {
  const agent = USAGE_PROVIDER_LOGO_AGENT[provider]
  if (!agent || !hasMobileAgentIcon(agent)) {
    return undefined
  }
  return <MobileAgentIcon agentId={agent} size={USAGE_TAB_LOGO_SIZE} />
}
