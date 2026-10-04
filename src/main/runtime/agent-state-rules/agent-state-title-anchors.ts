import { isOpenCodeNativeTitle } from '../../../shared/opencode-terminal-title'
import { compileTextTest } from './agent-state-rule-matchers'
import { compiledFromActiveAgentStateRules } from './active-agent-state-rules'
import type {
  AgentStateRulesFile,
  NamedTitlePredicate,
  TitleAnchorCondition
} from './agent-state-rules-schema'

// Why shared code: the same marker also proves OpenCode presence, so both must read it alike.
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

/** Whether any rule file's title anchor marks an idle-classified `title` as an agent's own rest title. */
export function showsIdleTitleAnchor(title: string): boolean {
  return titleAnchors().some((matches) => matches(title))
}
