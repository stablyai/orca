import type { PetLibrary, PetMutationResult } from '../../shared/pet-types'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { formatPetLibrary, formatPetMutation } from '../pet-format'
import { resolveRepoPathArgument } from '../repo-path-arguments'

export const PET_HANDLERS: Record<string, CommandHandler> = {
  'pet list': async ({ client, json }) => {
    const result = await client.call<PetLibrary>('pet.list')
    printResult(result, json, formatPetLibrary)
  },
  'pet import': async ({ flags, client, cwd, json }) => {
    const bundlePath = getRequiredStringFlag(flags, 'path')
    const result = await client.call<PetMutationResult>('pet.importBundle', {
      // Why: the runtime copies the bundle from its own filesystem, so a paired host needs an absolute path.
      path: resolveRepoPathArgument(bundlePath, cwd, client.isRemote, 'Remote pet import'),
      name: getOptionalStringFlag(flags, 'name')
    })
    printResult(result, json, formatPetMutation('Imported'))
  },
  'pet select': async ({ flags, client, json }) => {
    const result = await client.call<PetLibrary>('pet.select', {
      pet: getRequiredStringFlag(flags, 'pet')
    })
    printResult(result, json, formatPetLibrary)
  },
  'pet rename': async ({ flags, client, json }) => {
    const result = await client.call<PetMutationResult>('pet.rename', {
      pet: getRequiredStringFlag(flags, 'pet'),
      name: getRequiredStringFlag(flags, 'name')
    })
    printResult(result, json, formatPetMutation('Renamed'))
  },
  'pet rm': async ({ flags, client, json }) => {
    const result = await client.call<PetMutationResult>('pet.remove', {
      pet: getRequiredStringFlag(flags, 'pet')
    })
    printResult(result, json, formatPetMutation('Removed'))
  }
}
