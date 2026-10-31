import { z } from 'zod'
import {
  isJournalOpenUnionFallback,
  isJournalTag
} from '../../../shared/agent-session-journal-open-union'
import type { AgentJournalUnknownKind } from '../../../shared/agent-session-journal-types'

// The wire reads a peer's or an older build's value openly. A saved value is different: a build
// that kept a key it does not declare would restate the value without it, so storage refuses the
// chat instead. Only key and union-tag sets are closed; string vocabularies keep the wire's
// fallbacks, and `z.unknown()` stays an opaque value carried whole.

/** The strict form of a declared schema: objects refuse undeclared keys, open unions refuse
 * unknown tags. Checks are kept; a schema kind storage cannot close fails at load. */
export function strictStorage(schema: z.core.$ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(
      Object.entries(schema.shape).map(([key, value]) => [key, strictStorage(value)])
    )
    return schema.clone({ ...schema.def, shape, catchall: z.never() })
  }
  if (schema instanceof z.ZodUnion) {
    const options = schema.options.filter((option) => !isJournalOpenUnionFallback(option))
    const [known] = options
    // An open union is its known arms and a fallback that kept the tags storage refuses.
    return known && options.length === 1 && schema.options.length === 2
      ? strictStorage(known)
      : schema.clone({ ...schema.def, options: options.map(strictStorage) })
  }
  if (schema instanceof z.ZodOptional) {
    return strictStorage(schema.unwrap()).optional()
  }
  if (schema instanceof z.ZodNullable) {
    return strictStorage(schema.unwrap()).nullable()
  }
  if (schema instanceof z.ZodArray) {
    return schema.clone({ ...schema.def, element: strictStorage(schema.element) })
  }
  if (schema instanceof z.ZodTuple) {
    const { items, rest } = schema.def
    return schema.clone({
      ...schema.def,
      items: items.map(strictStorage),
      rest: rest && strictStorage(rest)
    })
  }
  if (schema instanceof z.ZodRecord) {
    return schema.clone({ ...schema.def, valueType: strictStorage(schema.def.valueType) })
  }
  if (
    schema instanceof z.ZodString ||
    schema instanceof z.ZodNumber ||
    schema instanceof z.ZodBoolean ||
    schema instanceof z.ZodLiteral ||
    schema instanceof z.ZodEnum ||
    schema instanceof z.ZodNull ||
    schema instanceof z.ZodUnknown
  ) {
    return schema
  }
  throw new Error(`saved journal storage cannot close a ${schema._zod.def.type} schema`)
}

/** `newer` when the value holds a key or union tag this build does not declare; `damage` when it
 * fails a type this build declares, a blank tag included. */
export function storageVerdict(schema: z.ZodType, value: unknown): 'stored' | 'newer' | 'damage' {
  const parsed = schema.safeParse(value)
  if (parsed.success) {
    return 'stored'
  }
  return parsed.error.issues.some((issue) => undeclared(issue, value)) ? 'newer' : 'damage'
}

// A union's issues locate values relative to the union's own input.
function undeclared(issue: z.core.$ZodIssue, input: unknown): boolean {
  if (issue.code === 'unrecognized_keys') {
    return true
  }
  if (issue.code !== 'invalid_union') {
    return false
  }
  const at = issue.path.reduce(child, input)
  if (issue.discriminator !== undefined && issue.errors.length === 0) {
    return isJournalTag(at)
  }
  return issue.errors.some((errors) => errors.some((inner) => undeclared(inner, at)))
}

function child(value: unknown, key: PropertyKey): unknown {
  return typeof value === 'object' && value !== null
    ? Object.entries(value).find(([name]) => name === String(key))?.[1]
    : undefined
}

type Get<O, K> = K extends keyof O ? O[K] : never
type At<A, K> = A extends unknown ? Get<A, K> : never
type TagKeys<S> = Exclude<
  { [K in keyof S]: S[K] extends string ? (string extends S[K] ? never : K) : never }[keyof S],
  undefined
>
// The storage arm a value of type T is stored under: the one whose required literal tags it has.
type Arm<T, S> = S extends object
  ? { [K in TagKeys<S> & keyof T]: Get<T, K> } extends { [K in TagKeys<S> & keyof T]: Get<S, K> }
    ? S
    : never
  : never
type Keys<A> = A extends unknown ? keyof A : never
type ArmKeys<T, A> = [A] extends [never]
  ? 'a value no storage arm declares'
  :
      | Exclude<keyof T, Keys<A>>
      | { [K in keyof T & Keys<A>]: UndeclaredStorageKeys<T[K], At<A, K>> }[keyof T & Keys<A>]

/** Keys of a persisted type, at any depth and in any union member, that its storage schema's
 * output `S` leaves undeclared; `never` when it declares them all. An unknown-kind value never
 * reaches storage: admission refuses it. A primitive holds no keys; it is settled before `object`
 * because an open or branded string (`AgentType`'s `string & {}`) is assignable to `object`. */
export type UndeclaredStorageKeys<T, S> = unknown extends S
  ? never
  : T extends { readonly kind: AgentJournalUnknownKind }
    ? never
    : T extends string | number | boolean | bigint | symbol | null | undefined
      ? never
      : T extends readonly (infer E)[]
        ? [Extract<S, readonly unknown[]>] extends [never]
          ? 'an array storage does not declare'
          : UndeclaredStorageKeys<E, Extract<S, readonly unknown[]>[number]>
        : T extends object
          ? ArmKeys<T, Arm<T, S>>
          : never

/** Compiles only when every persisted key is declared. */
export type StorageDeclaresAll<Undeclared extends never> = Undeclared
