import { isOpenCodeNativeTitle } from '../../../shared/opencode-terminal-title'
import { compileTextTest } from './agent-state-rule-matchers'
import { compiledFromActiveAgentStateRules } from './active-agent-state-rules'
import type {
  AgentStateRulesFile,
  NamedTitlePredicate,
  TitleAnchorCondition
} from './agent-state-rules-schema'

// Presence and readiness must interpret the OpenCode marker identically.
const NAMED_TITLE_PREDICATES: Record<NamedTitlePredicate, (title: string) => boolean> = {
  'opencode-native-title': isOpenCodeNativeTitle
}

type TitleAnchorMatcher = (title: string) => boolean

function compileTitleAnchor(when: TitleAnchorCondition): TitleAnchorMatcher {
  return 'predicate' in when.match
    ? NAMED_TITLE_PREDICATES[when.match.predicate]
    : compileTextTest(when.match)
}

function compileTitleAnchors(files: readonly AgentStateRulesFile[]): TitleAnchorMatcher[] {
  return files.flatMap((file) =>
    file.anchors.flatMap(({ when }) => (when.region === 'title' ? [compileTitleAnchor(when)] : []))
  )
}

const titleAnchors = compiledFromActiveAgentStateRules(compileTitleAnchors)

export function showsIdleTitleAnchor(title: string): boolean {
  return titleAnchors().some((matches) => matches(title))
}
