// Fixtures allow deep partial domain values and host JSON nulls; preserve callback signatures and Set/Map types.
// Keep this in the engine: recording fences exclude other mobile paths, and adapters cannot import one another.
export type PartialRecorderFixture<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlySet<unknown> | ReadonlyMap<unknown, unknown>
    ? T
    : T extends readonly (infer Element)[]
      ? readonly PartialRecorderFixture<Element>[]
      : T extends object
        ? { readonly [Key in keyof T]?: PartialRecorderFixture<T[Key]> | null }
        : T

// NoInfer checks against the action’s target type; partial fixtures must not invent unknown or mistyped members.
export function mountFixture<T>(value: PartialRecorderFixture<NoInfer<T>>): T {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked as a deep subset of T above; the recorder supplies every member the action reads.
  return value as T
}

// Keep compile fences on a reachable recorder path; mobile typechecking excludes test files and mutant-seam rejects orphan modules.
type Fixture = {
  readonly onPick: (id: string) => void
  readonly at: Date
  readonly tags: ReadonlySet<string>
  readonly byId: ReadonlyMap<string, number>
  readonly labels: readonly { readonly name: string }[]
  readonly source: { readonly id: string } | undefined
}

export const accepted = mountFixture<Fixture>({
  onPick: () => {},
  labels: [{ name: 'bug' }],
  // JSON spells an absent object `null`, which the product type does not say
  source: null
})

export const refusedCallback = mountFixture<Fixture>({
  // @ts-expect-error a number cannot stand in for the callback the hook invokes
  onPick: 3
})

export const refusedDate = mountFixture<Fixture>({
  // @ts-expect-error a structural stand-in is not the Date the hook reads
  at: { getTime: 5 }
})

export const refusedSet = mountFixture<Fixture>({
  // @ts-expect-error an object with no Set members is not a Set
  tags: {}
})

export const refusedMap = mountFixture<Fixture>({
  // @ts-expect-error an object with no Map members is not a Map
  byId: {}
})

export const refusedMember = mountFixture<Fixture>({
  // @ts-expect-error the product type has no such member
  unknownMember: 'x'
})

export const refusedElement = mountFixture<Fixture>({
  // @ts-expect-error the element type has no such member
  labels: [{ nmae: 'bug' }]
})
