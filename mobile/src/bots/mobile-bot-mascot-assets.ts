import type { ImageSourcePropType } from 'react-native'
import type { BotMascotId } from '../../../src/shared/bot-avatar'

// The desktop's mascot pictures, shipped with the page. Literal paths, which the bundler follows; read on use, so
// code that never draws a bot never loads one.
export function mobileBotMascotAsset(id: BotMascotId): ImageSourcePropType {
  switch (id) {
    case 'A1':
      return require('../../../src/shared/bot-mascots/A1.webp')
    case 'B1':
      return require('../../../src/shared/bot-mascots/B1.webp')
    case 'D1':
      return require('../../../src/shared/bot-mascots/D1.webp')
    case 'E1':
      return require('../../../src/shared/bot-mascots/E1.webp')
    case 'F1':
      return require('../../../src/shared/bot-mascots/F1.webp')
    case 'G1':
      return require('../../../src/shared/bot-mascots/G1.webp')
    case 'H1':
      return require('../../../src/shared/bot-mascots/H1.webp')
    case 'H2':
      return require('../../../src/shared/bot-mascots/H2.webp')
    case 'I1':
      return require('../../../src/shared/bot-mascots/I1.webp')
    case 'J1':
      return require('../../../src/shared/bot-mascots/J1.webp')
    case 'K2':
      return require('../../../src/shared/bot-mascots/K2.webp')
    case 'L2':
      return require('../../../src/shared/bot-mascots/L2.webp')
    case 'M1':
      return require('../../../src/shared/bot-mascots/M1.webp')
    case 'N1':
      return require('../../../src/shared/bot-mascots/N1.webp')
    case 'O1':
      return require('../../../src/shared/bot-mascots/O1.webp')
    case 'P3':
      return require('../../../src/shared/bot-mascots/P3.webp')
    case 'Q1':
      return require('../../../src/shared/bot-mascots/Q1.webp')
    case 'R3':
      return require('../../../src/shared/bot-mascots/R3.webp')
    case 'S2':
      return require('../../../src/shared/bot-mascots/S2.webp')
    case 'T1':
      return require('../../../src/shared/bot-mascots/T1.webp')
  }
}
