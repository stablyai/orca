import { describe, expect, it, vi } from 'vitest'
import { planWorktreeCreateNames } from './worktree-create-name-plan'
import {
  EMPTY_RETIRED_NAME_REGISTRY,
  type RetiredNameRegistry
} from '../shared/worktree/retired-name-registry'

function plan(args: {
  sanitizedName: string
  requestedName?: string
  nameWasGenerated?: boolean
  retired?: RetiredNameRegistry
}): ReturnType<typeof planWorktreeCreateNames> {
  return planWorktreeCreateNames({
    sanitizedName: args.sanitizedName,
    requestedName: args.requestedName ?? args.sanitizedName,
    nameWasGenerated: args.nameWasGenerated,
    loadRetiredNames: async () => args.retired ?? EMPTY_RETIRED_NAME_REGISTRY
  })
}

/** The candidate ladder, with retired rungs dropped the way the create loops drop them. */
function walk(
  namePlan: Awaited<ReturnType<typeof planWorktreeCreateNames>>,
  suffixes: number
): string[] {
  const taken: string[] = []
  for (let suffix = 1; suffix <= suffixes; suffix += 1) {
    const candidate = namePlan.candidateAt(suffix)
    if (candidate) {
      taken.push(candidate.sanitizedName)
    }
  }
  return taken
}

describe('planWorktreeCreateNames', () => {
  it('steps over a retired cwd for a generated name', async () => {
    const namePlan = await plan({
      sanitizedName: 'nautilus',
      nameWasGenerated: true,
      retired: { exhaustedTiers: 0, names: ['nautilus'] }
    })

    expect(namePlan.candidateAt(1)).toBeNull()
    expect(namePlan.candidateAt(2)).toEqual({
      sanitizedName: 'nautilus-2',
      requestedName: 'nautilus-2'
    })
  })

  it('hands a typed name the retired cwd it asked for', async () => {
    // Why: the pool is ordinary English, and people type those words on purpose. Redirecting a
    // deliberate `nautilus` to `nautilus-2` is a worse surprise than inheriting a spent cwd.
    const namePlan = await plan({
      sanitizedName: 'nautilus',
      nameWasGenerated: false,
      retired: { exhaustedTiers: 0, names: ['nautilus'] }
    })

    expect(namePlan.candidateAt(1)).toEqual({
      sanitizedName: 'nautilus',
      requestedName: 'nautilus'
    })
  })

  it('treats a client that omits the provenance bit as having typed the name', async () => {
    // Why: clients predating `nameWasGenerated` are indistinguishable from a typing user, and
    // pre-#14350 they kept the cwd. Guessing "generated" would silently redirect real requests.
    const loadRetiredNames = vi.fn(async () => ({ exhaustedTiers: 0, names: ['nautilus'] }))

    const namePlan = await planWorktreeCreateNames({
      sanitizedName: 'nautilus',
      requestedName: 'nautilus',
      nameWasGenerated: undefined,
      loadRetiredNames
    })

    expect(namePlan.candidateAt(1)).toEqual({
      sanitizedName: 'nautilus',
      requestedName: 'nautilus'
    })
    // The typed path never consults the registry, so it never pays for its backfill scan either.
    expect(loadRetiredNames).not.toHaveBeenCalled()
    expect(namePlan.retiresCreatedName).toBe(true)
  })

  it('never loads the registry for a name the generator could not have produced', async () => {
    const loadRetiredNames = vi.fn(async () => ({ exhaustedTiers: 0, names: ['fix-login'] }))

    const namePlan = await planWorktreeCreateNames({
      sanitizedName: 'fix-login',
      requestedName: 'fix-login',
      nameWasGenerated: undefined,
      loadRetiredNames
    })

    expect(loadRetiredNames).not.toHaveBeenCalled()
    expect(namePlan.retiresCreatedName).toBe(false)
    expect(walk(namePlan, 2)).toEqual(['fix-login', 'fix-login-2'])
  })

  it('keeps a typed name literal instead of canonicalizing it onto the tier ladder', async () => {
    // `nautilus-2-3` is a legacy repeat-suffixed spelling. The generated ladder folds it to
    // `nautilus-4`; a name the user typed must keep the directory it asked for.
    const typed = await plan({ sanitizedName: 'nautilus-2-3' })
    const generated = await plan({ sanitizedName: 'nautilus-2-3', nameWasGenerated: true })

    expect(walk(typed, 2)).toEqual(['nautilus-2-3', 'nautilus-2-3-2'])
    expect(walk(generated, 2)).toEqual(['nautilus-4', 'nautilus-5'])
  })

  it('suffixes the display name in step with a typed name a path collision pushed along', async () => {
    const namePlan = await plan({ sanitizedName: 'nautilus', requestedName: 'Nautilus' })

    expect(namePlan.candidateAt(2)).toEqual({
      sanitizedName: 'nautilus-2',
      requestedName: 'Nautilus-2'
    })
  })

  it('starts a generated name past the compaction watermark rather than walking every spent tier', async () => {
    const namePlan = await plan({
      sanitizedName: 'nautilus',
      nameWasGenerated: true,
      retired: { exhaustedTiers: 3, names: [] }
    })

    expect(walk(namePlan, 2)).toEqual(['nautilus-4', 'nautilus-5'])
  })

  it('records a pool-shaped name as spent however the client labelled it', async () => {
    await expect(plan({ sanitizedName: 'nautilus' })).resolves.toMatchObject({
      retiresCreatedName: true
    })
    await expect(
      plan({ sanitizedName: 'nautilus', nameWasGenerated: true })
    ).resolves.toMatchObject({ retiresCreatedName: true })
  })
})
