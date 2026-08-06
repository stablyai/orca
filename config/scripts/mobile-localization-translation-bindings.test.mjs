import { describe, expect, it } from 'vitest'

import { collectMobileTranslationCalls } from './verify-mobile-localization-catalog.mjs'

describe('mobile-localization-translation-bindings', () => {
  it('finds forward and assignment translator aliases to a fixed point', () => {
    const sourceText = `
import { createMobileTranslator, t } from '@/i18n/mobile-i18n'
import * as i18n from '@/i18n/mobile-i18n'
export function forwardLabel() {
  const tr = laterAlias
  return tr('example.forward')
}
const laterAlias = t
let assigned
assigned = t
let destructured
;({ t: destructured } = i18n)
let prefixed
prefixed = createMobileTranslator('example')
export const labels = [
  assigned('example.assigned'),
  destructured('example.destructured'),
  prefixed('prefixed')
]
`
    const calls = collectMobileTranslationCalls('/repo/mobile/app/Example.tsx', sourceText, '/repo')

    expect(calls.map((call) => call.keys)).toEqual([
      ['example.forward'],
      ['example.assigned'],
      ['example.destructured'],
      ['example.prefixed']
    ])
  })

  it('keeps namespace var translators inside their module scope', () => {
    const sourceText = `
import { t } from '@/i18n/mobile-i18n'
namespace Local {
  var t = (value) => value
  export const raw = t('not-a-translation-key')
}
export const translated = t('example.translated')
`
    const calls = collectMobileTranslationCalls('/repo/mobile/app/Example.tsx', sourceText, '/repo')

    expect(calls.map((call) => call.keys)).toEqual([['example.translated']])
  })

  it('tracks translators through object members and destructuring assignments', () => {
    const sourceText = `
import { t } from '@/i18n/mobile-i18n'
const box = { tr: t }
const { tr } = box
let assigned
;({ tr: assigned } = box)
export const labels = [
  box.tr('example.member'),
  tr('example.destructured'),
  assigned('example.assigned')
]
`
    const calls = collectMobileTranslationCalls('/repo/mobile/app/Example.tsx', sourceText, '/repo')

    expect(calls.map((call) => call.keys)).toEqual([
      ['example.member'],
      ['example.destructured'],
      ['example.assigned']
    ])
  })

  it('uses the translator definition that reaches each call', () => {
    const sourceText = `
import { createMobileTranslator, t } from '@/i18n/mobile-i18n'
let replaced = t
replaced = (value) => value
let prefixed = createMobileTranslator('first')
prefixed = createMobileTranslator('second')
export const labels = [replaced('Raw visible copy'), prefixed('title')]
`
    const calls = collectMobileTranslationCalls('/repo/mobile/app/Example.tsx', sourceText, '/repo')

    expect(calls.map((call) => call.keys)).toEqual([['second.title']])
  })

  it('evaluates alias snapshots at their assignment sites', () => {
    const sourceText = `
import { t } from '@/i18n/mobile-i18n'
const raw = (value) => value
let source = raw
const snapshot = source
source = t
const box = { tr: raw }
const { tr: memberSnapshot } = box
box.tr = t
let objectSource = { tr: raw }
const objectSnapshot = objectSource
objectSource = { tr: t }
export const labels = [
  snapshot('Raw binding snapshot'),
  memberSnapshot('Raw member snapshot'),
  objectSnapshot.tr('Raw object snapshot'),
  source('example.binding'),
  box.tr('example.member')
]
`
    const calls = collectMobileTranslationCalls('/repo/mobile/app/Example.tsx', sourceText, '/repo')

    expect(calls.map((call) => call.keys)).toEqual([['example.binding'], ['example.member']])
  })

  it('includes later outer writes that can reach closure calls', () => {
    const sourceText = `
import { t } from '@/i18n/mobile-i18n'
const raw = (value) => value
let closure = t
const box = { tr: t }
function render() {
  return [closure('Raw scalar closure'), box.tr('Raw member closure')]
}
closure = raw
box.tr = raw
export const labels = render()
`
    const calls = collectMobileTranslationCalls('/repo/mobile/app/Example.tsx', sourceText, '/repo')

    expect(calls).toEqual([])
  })

  it('tracks member and logical assignments at each call', () => {
    const sourceText = `
import { t } from '@/i18n/mobile-i18n'
const replaced = { tr: t }
replaced.tr = (value) => value
const assigned = {}
assigned['tr'] = t
let logical
logical ??= t
let overwritten = t
overwritten &&= (value) => value
export const labels = [
  replaced.tr('Raw member copy'),
  assigned.tr('example.element'),
  logical('example.logical'),
  overwritten('Raw logical copy')
]
`
    const calls = collectMobileTranslationCalls('/repo/mobile/app/Example.tsx', sourceText, '/repo')

    expect(calls.map((call) => call.keys)).toEqual([['example.element'], ['example.logical']])
  })

  it('tracks aliased and nested property writes', () => {
    const sourceText = `
import { t } from '@/i18n/mobile-i18n'
const raw = (value) => value
const box = { tr: t }
const alias = box
alias['tr'] = raw
const holder = { inner: { tr: t } }
holder.inner.tr('example.nested')
holder.inner.tr = raw
const assigned = { inner: {} }
assigned.inner.tr = t
export const labels = [
  box.tr('Raw aliased mutation'),
  holder.inner.tr('Raw nested mutation'),
  assigned.inner.tr('example.nestedAssigned')
]
`
    const calls = collectMobileTranslationCalls('/repo/mobile/app/Example.tsx', sourceText, '/repo')

    expect(calls.map((call) => call.keys)).toEqual([['example.nested'], ['example.nestedAssigned']])
  })

  it('applies statically determined logical assignments', () => {
    const sourceText = `
import { t } from '@/i18n/mobile-i18n'
const raw = (value) => value
let nullishKeep = t
nullishKeep ??= raw
let orKeep = t
orKeep ||= raw
let nullishAssign = undefined
nullishAssign ??= t
let andReplace = t
andReplace &&= raw
const propertyKeep = { tr: t }
propertyKeep.tr ??= raw
const propertyAssign = {}
propertyAssign.tr ??= t
export const labels = [
  nullishKeep('example.nullishKeep'),
  orKeep('example.orKeep'),
  nullishAssign('example.nullishAssign'),
  propertyKeep.tr('example.propertyKeep'),
  propertyAssign.tr('example.propertyAssign'),
  andReplace('Raw logical replacement')
]
`
    const calls = collectMobileTranslationCalls('/repo/mobile/app/Example.tsx', sourceText, '/repo')

    expect(calls.map((call) => call.keys)).toEqual([
      ['example.nullishKeep'],
      ['example.orKeep'],
      ['example.nullishAssign'],
      ['example.propertyKeep'],
      ['example.propertyAssign']
    ])
  })

  it('unwraps non-null translator expressions', () => {
    const sourceText = `
import { t } from '@/i18n/mobile-i18n'
const tr: typeof t | undefined = t
export const label = tr!('example.nonNull')
`
    const calls = collectMobileTranslationCalls('/repo/mobile/app/Example.tsx', sourceText, '/repo')

    expect(calls.map((call) => call.keys)).toEqual([['example.nonNull']])
  })

  it('terminates potential analysis for self-referential member writes', () => {
    const sourceText = `
const holder = makeHolder()
holder.current = holder.current.filter(Boolean)
const next = holder.current.filter(Boolean)
export const labels = next.map((value) => value.label)
`
    const calls = collectMobileTranslationCalls('/repo/mobile/app/Example.tsx', sourceText, '/repo')

    expect(calls).toEqual([])
  })

  it('keeps translator identity across self-referential member writes', () => {
    const sourceText = `
import { t } from '@/i18n/mobile-i18n'
const holder = { current: t }
holder.current = holder.current
const a = { tr: t }
const b = { tr: (value) => value }
let y = a
y &&= b
a.tr = y.tr
export const labels = [holder.current('example.selfReference'), a.tr('Raw ambiguous write')]
`
    const calls = collectMobileTranslationCalls('/repo/mobile/app/Example.tsx', sourceText, '/repo')

    expect(calls.map((call) => call.keys)).toEqual([['example.selfReference']])
  })

  it('resolves long mutable reverse alias chains without whole-file fixed-point rescans', () => {
    const aliases = Array.from({ length: 1500 }, (_, index) =>
      index === 1499 ? `let alias${index} = t` : `let alias${index} = alias${index + 1}`
    ).join('\n')
    const sourceText = `
import { t } from '@/i18n/mobile-i18n'
${aliases}
alias1499 ??= (value) => value
export const label = alias0('example.scaled')
`
    const startedAt = performance.now()
    const calls = collectMobileTranslationCalls('/repo/mobile/app/Example.tsx', sourceText, '/repo')

    expect(calls.map((call) => call.keys)).toEqual([['example.scaled']])
    expect(performance.now() - startedAt).toBeLessThan(1000)
  })

  it('collects long potential alias chains after a changing logical write', () => {
    const aliases = Array.from({ length: 1500 }, (_, index) =>
      index === 1499 ? `let alias${index} = t` : `let alias${index} = alias${index + 1}`
    ).join('\n')
    const sourceText = `
import { t } from '@/i18n/mobile-i18n'
${aliases}
alias1499 &&= (value) => value
export const label = alias0('Raw potential alias')
`
    const startedAt = performance.now()
    const calls = collectMobileTranslationCalls('/repo/mobile/app/Example.tsx', sourceText, '/repo')

    expect(calls).toEqual([])
    expect(performance.now() - startedAt).toBeLessThan(1000)
  })
})
