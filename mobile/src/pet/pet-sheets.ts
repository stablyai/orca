import type { ImageSourcePropType } from 'react-native'

// Static require map for bundled pet sheets.
//
// Why static: Metro resolves requires at BUILD time, so a computed path like
// require(`.../${id}/spritesheet.webp`) does not bundle anything and the pet
// renders invisible. Generated alongside pet-frames.generated.json — if you add
// a pet to resources/pets/mesh-defaults, rerun `pnpm run build:pet-frames` and
// add its line here.
export const PET_SHEETS: Record<string, ImageSourcePropType> = {
  'apupepe': require('../../../resources/pets/mesh-defaults/apupepe/spritesheet.webp'),
  'clank': require('../../../resources/pets/mesh-defaults/clank/spritesheet.webp'),
  'claw-crawler': require('../../../resources/pets/mesh-defaults/claw-crawler/spritesheet.webp'),
  'faye': require('../../../resources/pets/mesh-defaults/faye/spritesheet.webp'),
  'gojo': require('../../../resources/pets/mesh-defaults/gojo/spritesheet.webp'),
  'mini-gandalf-the-grey': require('../../../resources/pets/mesh-defaults/mini-gandalf-the-grey/spritesheet.webp'),
  'nezukocoder': require('../../../resources/pets/mesh-defaults/nezukocoder/spritesheet.webp'),
  'nous-girl': require('../../../resources/pets/mesh-defaults/nous-girl/spritesheet.webp'),
  'rubick': require('../../../resources/pets/mesh-defaults/rubick/spritesheet.webp'),
  'spike': require('../../../resources/pets/mesh-defaults/spike/spritesheet.webp'),
  'strike-freedom': require('../../../resources/pets/mesh-defaults/strike-freedom/spritesheet.webp'),
  'teknium': require('../../../resources/pets/mesh-defaults/teknium/spritesheet.webp')
}

export function petSheetFor(id: string): ImageSourcePropType | null {
  return PET_SHEETS[id] ?? null
}
