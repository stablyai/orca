import { describe, expect, it } from 'vitest'
import { ORCA_CLOUD_RECIPE_ID } from '../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { missingRecipeFailure } from './orca-cloud-missing-recipe'

describe('missingRecipeFailure', () => {
  it('asks to sign in when an Orca Cloud create runs after the session ended', async () => {
    const failure = await missingRecipeFailure(ORCA_CLOUD_RECIPE_ID, async () => 'needs-sign-in')
    expect(failure.errorCode).toBe('cloudSignInRequired')
  })

  it('routes an unentitled account to plans and an unreachable service to try again', async () => {
    expect(
      (await missingRecipeFailure(ORCA_CLOUD_RECIPE_ID, async () => 'needs-capability')).errorCode
    ).toBe('cloudPlanRequired')
    expect(
      (await missingRecipeFailure(ORCA_CLOUD_RECIPE_ID, async () => 'unavailable')).errorCode
    ).toBe('cloudUnavailable')
  })

  it('keeps recipe-not-found for other recipes without asking Orca Cloud', async () => {
    let asked = false
    const failure = await missingRecipeFailure('plugin:vm', async () => {
      asked = true
      return 'needs-sign-in'
    })
    expect(failure.errorCode).toBe('recipeNotFound')
    expect(asked).toBe(false)
  })
})
