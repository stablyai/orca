import type { DnrDomainList } from './domain-matching'
import type { DnrIndexedRule } from './indexed-rule'
import { dnrNgramDictionary, patternNgrams } from './ngram-dictionary'
import type { DnrRequestContext } from './request-context'
import { toLowerAscii } from './url-text'

// One url_pattern_index (url_pattern_index.cc UrlPatternIndexBuilder): rules keyed by a 5-gram
// of their filter. Rules without one are keyed by an included request or initiator domain,
// else scanned on every request as Chromium's fallback list is. Keys only pick candidates;
// every candidate is still fully matched.

// Chromium takes whichever n-gram has the shortest list so far, which can pick "https" or
// "s://a" and make a rule a candidate for most requests. Here n-grams spanning the scheme
// separator or common URL words rank last and n-grams of a leading host name rank first.
const COMMON_URL_NGRAMS = new Set(
  [
    'https://www.',
    'http://www.',
    '.com/',
    '.net/',
    '.org/',
    '.html',
    '/index.',
    '/wp-content/',
    '/uploads/',
    '/plugins/',
    '/themes/',
    '/static/',
    '/assets/',
    '/images/',
    '.min.js',
    'google'
  ].flatMap((text) => patternNgrams(text).map(({ high, low }) => `${high}:${low}`))
)
const PATH_NGRAM_PENALTY = 4

function ngramCost(
  text: string,
  hostEnd: number,
  gram: { high: number; low: number; start: number }
): number {
  if (
    text.slice(gram.start, gram.start + 5).includes(':') ||
    COMMON_URL_NGRAMS.has(`${gram.high}:${gram.low}`)
  ) {
    return 1e9
  }
  return gram.start + 5 <= hostEnd ? 0 : PATH_NGRAM_PENALTY
}

/** Length of a leading host name such as "ads.example.com" in "ads.example.com/x"; 0 if none. */
function leadingHostLength(text: string): number {
  const match = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?=[/^:?*]|$)/.exec(text)
  return match ? match[0].length : 0
}

const NO_LISTS: readonly DnrIndexedRule[][] = []

/**
 * Candidate order: higher index priority first. Chromium leaves equal priorities in no defined
 * order inside one index; the higher id wins here, as RequestAction's own tie-break does.
 */
export function compareRulePriority(left: DnrIndexedRule, right: DnrIndexedRule): number {
  return right.indexPriority - left.indexPriority || right.id - left.id
}

/** Domains a host-suffix lookup can find: DomainIs matches only these at label boundaries. */
function suffixKeys(list: DnrDomainList | null): readonly string[] | null {
  if (
    list === null ||
    list.domains.some((domain) => domain === '' || domain.startsWith('.') || domain.endsWith('.'))
  ) {
    return null
  }
  return list.domains
}

export class DnrRulePartition {
  private readonly byNgram = new Map<number, DnrIndexedRule[]>()
  private readonly byRequestDomain = new Map<string, DnrIndexedRule[]>()
  private readonly byInitiatorDomain = new Map<string, DnrIndexedRule[]>()
  private readonly unindexed: DnrIndexedRule[] = []
  size = 0
  // Per-request scratch filled by DnrCandidatePostings; valid only while `hitEpoch` matches.
  private hitEpoch = -1
  private hitLists: DnrIndexedRule[][] = []

  /** Rules with an n-gram key (url filters or regex literals). */
  add(rule: DnrIndexedRule, keyText: string): void {
    this.size++
    const ngram = this.mostDistinctiveNgram(toLowerAscii(keyText))
    if (ngram !== -1) {
      push(this.byNgram, ngram, rule)
      return
    }
    const requestKeys = suffixKeys(rule.requestDomains)
    if (requestKeys !== null) {
      for (const domain of requestKeys) {
        push(this.byRequestDomain, domain, rule)
      }
      return
    }
    const initiatorKeys = suffixKeys(rule.initiatorDomains)
    if (initiatorKeys !== null) {
      for (const domain of initiatorKeys) {
        push(this.byInitiatorDomain, domain, rule)
      }
      return
    }
    this.unindexed.push(rule)
  }

  /** Must run once after the last add. */
  finish(): void {
    for (const lists of [this.byNgram, this.byRequestDomain, this.byInitiatorDomain]) {
      for (const rules of lists.values()) {
        rules.sort(compareRulePriority)
      }
    }
    this.unindexed.sort(compareRulePriority)
  }

  /** GetMostDistinctiveNGram: the uncommon n-gram whose list is currently shortest. */
  private mostDistinctiveNgram(text: string): number {
    const dictionary = dnrNgramDictionary()
    let best: { high: number; low: number } | null = null
    let bestCost = Infinity
    const hostEnd = leadingHostLength(text)
    for (const gram of patternNgrams(text)) {
      const id = dictionary.lookup(gram.high, gram.low, false)
      const size = id === -1 ? 0 : (this.byNgram.get(id)?.length ?? 0)
      const cost = size + ngramCost(text, hostEnd, gram)
      if (cost < bestCost) {
        best = gram
        bestCost = cost
        if (cost === 0) {
          break
        }
      }
    }
    return best === null ? -1 : dictionary.lookup(best.high, best.low, true)
  }

  keyedLists(): {
    ngram: ReadonlyMap<number, DnrIndexedRule[]>
    requestDomain: ReadonlyMap<string, DnrIndexedRule[]>
    initiatorDomain: ReadonlyMap<string, DnrIndexedRule[]>
    hasUnindexed: boolean
  } {
    return {
      ngram: this.byNgram,
      requestDomain: this.byRequestDomain,
      initiatorDomain: this.byInitiatorDomain,
      hasUnindexed: this.unindexed.length > 0
    }
  }

  collectUnindexed(epoch: number): void {
    this.collect(epoch, this.unindexed)
  }

  collectNgram(epoch: number, id: number): void {
    this.collect(epoch, this.byNgram.get(id))
  }

  collectDomain(epoch: number, kind: 'request' | 'initiator', domain: string): void {
    this.collect(
      epoch,
      (kind === 'request' ? this.byRequestDomain : this.byInitiatorDomain).get(domain)
    )
  }

  private collect(epoch: number, rules: DnrIndexedRule[] | undefined): void {
    if (rules === undefined) {
      return
    }
    if (this.hitEpoch !== epoch) {
      this.hitEpoch = epoch
      this.hitLists = []
    }
    this.hitLists.push(rules)
  }

  /**
   * Candidate lists for a request, each sorted by priority: whatever DnrCandidatePostings routed
   * here for it. Read before the next request is routed.
   */
  candidateLists(context: DnrRequestContext): readonly DnrIndexedRule[][] {
    return context.ngramEpoch !== null && this.hitEpoch === context.ngramEpoch
      ? this.hitLists
      : NO_LISTS
  }
}

function push<K>(map: Map<K, DnrIndexedRule[]>, key: K, rule: DnrIndexedRule): void {
  const list = map.get(key)
  if (list) {
    list.push(rule)
  } else {
    map.set(key, [rule])
  }
}

type StagePartitions = {
  main: DnrRulePartition
  allowAllRequests: DnrRulePartition
  modifyHeaders: DnrRulePartition
  regex: DnrRulePartition
}

function stagePartitions(): StagePartitions {
  return {
    main: new DnrRulePartition(),
    allowAllRequests: new DnrRulePartition(),
    modifyHeaders: new DnrRulePartition(),
    regex: new DnrRulePartition()
  }
}

/** A ruleset's rules split by matching stage and index type (flat_ruleset_indexer.cc). */
export class DnrRulesetIndex {
  readonly beforeRequest = stagePartitions()
  readonly headersReceived = stagePartitions()
  regexRuleCount = 0

  constructor(rules: readonly DnrIndexedRule[] = []) {
    for (const rule of rules) {
      this.add(rule)
    }
    this.finish()
  }

  /** For incremental builds: add rules in order, then call finish() once. */
  add(rule: DnrIndexedRule): void {
    const stage = rule.stage === 'beforeRequest' ? this.beforeRequest : this.headersReceived
    if (rule.regex !== null) {
      this.regexRuleCount++
      stage.regex.add(rule, rule.regex.requiredLiteral)
    } else if (rule.urlPattern !== null) {
      const partition =
        rule.action === 'allowAllRequests'
          ? stage.allowAllRequests
          : rule.action === 'modifyHeaders'
            ? stage.modifyHeaders
            : stage.main
      partition.add(rule, rule.urlPattern.filter.pattern)
    }
  }

  finish(): void {
    for (const stage of [this.beforeRequest, this.headersReceived]) {
      for (const partition of Object.values(stage)) {
        partition.finish()
      }
    }
  }

  stage(stage: 'beforeRequest' | 'headersReceived'): StagePartitions {
    return stage === 'beforeRequest' ? this.beforeRequest : this.headersReceived
  }
}
