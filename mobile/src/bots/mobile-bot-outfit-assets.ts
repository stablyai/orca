import type { ImageSourcePropType } from 'react-native'
import { BOT_MASCOT_IDS, type BotMascotId } from '../../../src/shared/bot-avatar'
import type { BotAvatarOutfit } from '../../../src/shared/bots/bot-avatar-outfit'

// One sheet per outfit, each mascot's transparent render in BOT_MASCOT_IDS order, so an outfit adds one
// file to the app rather than one per mascot; read on use, as the pictures are.
const OUTFIT_SHEETS: Record<BotAvatarOutfit, () => ImageSourcePropType> = {
  tie: () => require('../../../src/shared/bot-mascots/outfits/tie.webp'),
  detective: () => require('../../../src/shared/bot-mascots/outfits/detective.webp'),
  'hard-hat': () => require('../../../src/shared/bot-mascots/outfits/hard-hat.webp'),
  reviewer: () => require('../../../src/shared/bot-mascots/outfits/reviewer.webp'),
  'night-shift': () => require('../../../src/shared/bot-mascots/outfits/night-shift.webp'),
  artist: () => require('../../../src/shared/bot-mascots/outfits/artist.webp'),
  scientist: () => require('../../../src/shared/bot-mascots/outfits/scientist.webp'),
  party: () => require('../../../src/shared/bot-mascots/outfits/party.webp'),
  security: () => require('../../../src/shared/bot-mascots/outfits/security.webp')
}

/** Mascots per row of an outfit sheet. */
export const OUTFIT_SHEET_COLUMNS = 5
export const OUTFIT_SHEET_ROWS = Math.ceil(BOT_MASCOT_IDS.length / OUTFIT_SHEET_COLUMNS)

/** The reviewer looks down at its page, so its render is the whole mascot, drawn instead of the picture. */
export function mobileBotOutfitReplacesPicture(outfit: BotAvatarOutfit): boolean {
  return outfit === 'reviewer'
}

/** The outfit sheet and its position in avatar widths and heights. */
export function mobileBotOutfitAsset(
  outfit: BotAvatarOutfit,
  id: BotMascotId
): { sheet: ImageSourcePropType; left: number; top: number } {
  const index = BOT_MASCOT_IDS.indexOf(id)
  // Coral is in the first column, so shifting its hard hat right exposes only empty space.
  const offset = id === 'G1' && outfit === 'hard-hat' ? 16 / 128 : 0
  return {
    sheet: OUTFIT_SHEETS[outfit](),
    left: offset - (index % OUTFIT_SHEET_COLUMNS),
    top: -Math.floor(index / OUTFIT_SHEET_COLUMNS)
  }
}
