import { percentile } from './relay-observability.js'
import { classifyAssignmentLease, type AssignmentLeaseClass } from './assignment-lease.js'

// What `ticketCheck=enforce` would have said, beside the database answer that still decides.
// `agree`/`disagree` replace `valid`: a valid lease the database refused is the case step 5
// has to explain before a lease alone may admit a host.
export type AssignmentLeaseShadowClass = Exclude<AssignmentLeaseClass, 'valid'> | 'agree' | 'disagree'

export const ASSIGNMENT_LEASE_SHADOW_EVENT = 'orca_relay_assignment_lease_shadow'
const WINDOW_MS = 60_000
// Flat per-class totals under `classes`, so a log-based metric can extract each by path.
const CLASS_FIELDS: ReadonlyArray<readonly [AssignmentLeaseShadowClass, string]> = [
  ['agree', 'agree'],
  ['disagree', 'disagree'],
  ['absent', 'absent'],
  ['expired', 'expired'],
  ['bad-signature', 'badSignature'],
  ['wrong-host', 'wrongHost'],
  ['wrong-cell', 'wrongCell'],
  ['epoch-behind', 'epochBehind'],
  ['epoch-ahead', 'epochAhead']
]
const MAX_DB_READ_SAMPLES = 2_000

export class AssignmentLeaseShadow {
  // Hellos the database refused, whatever the lease said; `disagree` is the valid-lease part.
  private dbRefused = 0
  private classes = new Map<AssignmentLeaseShadowClass, number>()
  private dbReadMs: number[] = []
  private windowStartedAt: number

  constructor(
    private readonly input: {
      enabled: () => boolean
      key: Uint8Array
      cellId: string
      now?: () => number
      log?: (line: string) => void
    }
  ) {
    this.windowStartedAt = this.now()
  }

  // Null when the switch is off, so the hello path does no extra work.
  check(input: {
    lease: string | undefined
    userId: string
    relayHostId: string
    helloEpoch: number
  }): Promise<AssignmentLeaseClass> | null {
    if (!this.input.enabled()) return null
    return classifyAssignmentLease({ ...input, key: this.input.key, cellId: this.input.cellId })
  }

  record(check: Promise<AssignmentLeaseClass>, dbValid: boolean, dbReadMs: number): void {
    void check
      .then((leaseClass) => {
        const shadowClass: AssignmentLeaseShadowClass =
          leaseClass === 'valid' ? (dbValid ? 'agree' : 'disagree') : leaseClass
        if (!dbValid) this.dbRefused += 1
        this.classes.set(shadowClass, (this.classes.get(shadowClass) ?? 0) + 1)
        if (this.dbReadMs.length < MAX_DB_READ_SAMPLES) this.dbReadMs.push(dbReadMs)
        this.flushIfDue()
      })
      .catch(() => undefined)
  }

  private flushIfDue(): void {
    const now = this.now()
    if (now - this.windowStartedAt < WINDOW_MS) return
    const log = this.input.log ?? console.log
    log(
      JSON.stringify({
        event: ASSIGNMENT_LEASE_SHADOW_EVENT,
        cellId: this.input.cellId,
        windowMs: now - this.windowStartedAt,
        classes: Object.fromEntries(
          CLASS_FIELDS.map(([shadowClass, field]) => [field, this.classes.get(shadowClass) ?? 0])
        ),
        dbRefused: this.dbRefused,
        // The hello's database read, which a lease-admitted hello would skip (E-pre).
        dbReadMs: {
          samples: this.dbReadMs.length,
          p50: percentile(this.dbReadMs, 0.5),
          p99: percentile(this.dbReadMs, 0.99),
          max: percentile(this.dbReadMs, 1)
        }
      })
    )
    this.dbRefused = 0
    this.classes = new Map()
    this.dbReadMs = []
    this.windowStartedAt = now
  }

  private now(): number {
    return (this.input.now ?? Date.now)()
  }
}
