import type { DnrRequestContext } from './request-context'
import type { DnrRulePartition, DnrRulesetIndex } from './ruleset-index'

// Engine-wide inverted index over every attached ruleset: n-gram id or domain -> the partitions
// keyed by it. A request walks its URL's n-grams and host suffixes once, however many rulesets
// are enabled, and each partition then picks up just the rule lists it was hit for.

// Process-wide so a partition's scratch can never be mistaken across engines.
let lastEpoch = 0

type Partitions = DnrRulePartition | DnrRulePartition[]

function partitionsOf(index: DnrRulesetIndex): DnrRulePartition[] {
  return [index.beforeRequest, index.headersReceived].flatMap((stage) => Object.values(stage))
}

// Most keys belong to one partition, so a lone partition is stored without an array.
function addPartition<K>(table: Map<K, Partitions>, key: K, partition: DnrRulePartition): void {
  const existing = table.get(key)
  if (existing === undefined) {
    table.set(key, partition)
  } else if (Array.isArray(existing)) {
    existing.push(partition)
  } else {
    table.set(key, [existing, partition])
  }
}

function removePartition<K>(table: Map<K, Partitions>, key: K, partition: DnrRulePartition): void {
  const existing = table.get(key)
  const remaining = Array.isArray(existing) ? existing.filter((entry) => entry !== partition) : []
  if (remaining.length === 0) {
    table.delete(key)
  } else {
    table.set(key, remaining.length === 1 ? remaining[0] : remaining)
  }
}

export class DnrCandidatePostings {
  private readonly byNgram = new Map<number, Partitions>()
  private readonly byRequestDomain = new Map<string, Partitions>()
  private readonly byInitiatorDomain = new Map<string, Partitions>()
  /** Partitions with rules no key could cover; every request visits them. */
  private readonly unkeyed = new Set<DnrRulePartition>()

  add(index: DnrRulesetIndex): void {
    for (const partition of partitionsOf(index)) {
      const keys = partition.keyedLists()
      if (keys.hasUnindexed) {
        this.unkeyed.add(partition)
      }
      for (const id of keys.ngram.keys()) {
        addPartition(this.byNgram, id, partition)
      }
      for (const domain of keys.requestDomain.keys()) {
        addPartition(this.byRequestDomain, domain, partition)
      }
      for (const domain of keys.initiatorDomain.keys()) {
        addPartition(this.byInitiatorDomain, domain, partition)
      }
    }
  }

  remove(index: DnrRulesetIndex): void {
    for (const partition of partitionsOf(index)) {
      const keys = partition.keyedLists()
      this.unkeyed.delete(partition)
      for (const id of keys.ngram.keys()) {
        removePartition(this.byNgram, id, partition)
      }
      for (const domain of keys.requestDomain.keys()) {
        removePartition(this.byRequestDomain, domain, partition)
      }
      for (const domain of keys.initiatorDomain.keys()) {
        removePartition(this.byInitiatorDomain, domain, partition)
      }
    }
  }

  /**
   * Routes a request's n-gram and host-suffix hits to the partitions keyed by them. Partitions
   * keep only the latest request's hits, so finish with one context before routing the next.
   */
  distribute(context: DnrRequestContext): void {
    const epoch = ++lastEpoch
    context.ngramEpoch = epoch
    for (const id of context.ngramIds) {
      const hit = this.byNgram.get(id)
      if (hit === undefined) {
        continue
      }
      if (Array.isArray(hit)) {
        for (const partition of hit) {
          partition.collectNgram(epoch, id)
        }
      } else {
        hit.collectNgram(epoch, id)
      }
    }
    for (const partition of this.unkeyed) {
      partition.collectUnindexed(epoch)
    }
    this.routeDomains(this.byRequestDomain, context.requestHostSuffixes, epoch, 'request')
    if (context.initiatorHost !== null) {
      this.routeDomains(this.byInitiatorDomain, context.initiatorHostSuffixes, epoch, 'initiator')
    }
  }

  private routeDomains(
    table: Map<string, Partitions>,
    suffixes: readonly string[],
    epoch: number,
    kind: 'request' | 'initiator'
  ): void {
    if (table.size === 0) {
      return
    }
    for (const suffix of suffixes) {
      const hit = table.get(suffix)
      if (hit === undefined) {
        continue
      }
      if (Array.isArray(hit)) {
        for (const partition of hit) {
          partition.collectDomain(epoch, kind, suffix)
        }
      } else {
        hit.collectDomain(epoch, kind, suffix)
      }
    }
  }
}
