import type { PetLibrary, PetMutationResult } from '../shared/pet-types'

export function formatPetLibrary(library: PetLibrary): string {
  const rows = library.pets.map((pet) => {
    const marker = pet.active ? '*' : ' '
    const name = pet.name === null ? '' : `  ${pet.name}`
    return `${marker} ${pet.id}  ${pet.kind}${name}`
  })
  const hidden = library.visible ? [] : ['', 'The pet is hidden. Selecting a pet shows it again.']
  return [...rows, ...hidden].join('\n')
}

export function formatPetMutation(verb: string): (result: PetMutationResult) => string {
  return (result) =>
    `${verb} ${result.pet.name} (${result.pet.id})\n\n${formatPetLibrary(result.library)}`
}
