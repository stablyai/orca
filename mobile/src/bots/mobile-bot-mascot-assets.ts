import type { ImageSourcePropType } from 'react-native'
import type { BotMascotId } from '../../../src/shared/bot-avatar'

// The desktop's mascot pictures at 256 px, like their rims: mobile draws them at most 88 pt, so desktop's 512 px set
// would only add page bytes. Literal paths, which the bundler follows; read on use, so code that never draws a bot
// never loads one.
export function mobileBotMascotAsset(id: BotMascotId): ImageSourcePropType {
  switch (id) {
    case 'A1':
      return require('../../assets/bot-mascots/A1.webp')
    case 'B1':
      return require('../../assets/bot-mascots/B1.webp')
    case 'D1':
      return require('../../assets/bot-mascots/D1.webp')
    case 'E1':
      return require('../../assets/bot-mascots/E1.webp')
    case 'F1':
      return require('../../assets/bot-mascots/F1.webp')
    case 'G1':
      return require('../../assets/bot-mascots/G1.webp')
    case 'H1':
      return require('../../assets/bot-mascots/H1.webp')
    case 'H2':
      return require('../../assets/bot-mascots/H2.webp')
    case 'I1':
      return require('../../assets/bot-mascots/I1.webp')
    case 'J1':
      return require('../../assets/bot-mascots/J1.webp')
    case 'K2':
      return require('../../assets/bot-mascots/K2.webp')
    case 'L2':
      return require('../../assets/bot-mascots/L2.webp')
    case 'M1':
      return require('../../assets/bot-mascots/M1.webp')
    case 'N1':
      return require('../../assets/bot-mascots/N1.webp')
    case 'O1':
      return require('../../assets/bot-mascots/O1.webp')
    case 'P3':
      return require('../../assets/bot-mascots/P3.webp')
    case 'Q1':
      return require('../../assets/bot-mascots/Q1.webp')
    case 'R3':
      return require('../../assets/bot-mascots/R3.webp')
    case 'S2':
      return require('../../assets/bot-mascots/S2.webp')
    case 'T1':
      return require('../../assets/bot-mascots/T1.webp')
  }
}

/** The mascot's light rim alone, drawn under it on a dark tile so a dark mascot doesn't sink into it. */
export function mobileBotMascotRimAsset(id: BotMascotId): ImageSourcePropType {
  switch (id) {
    case 'A1':
      return require('../../../src/shared/bot-mascots/A1-rim.webp')
    case 'B1':
      return require('../../../src/shared/bot-mascots/B1-rim.webp')
    case 'D1':
      return require('../../../src/shared/bot-mascots/D1-rim.webp')
    case 'E1':
      return require('../../../src/shared/bot-mascots/E1-rim.webp')
    case 'F1':
      return require('../../../src/shared/bot-mascots/F1-rim.webp')
    case 'G1':
      return require('../../../src/shared/bot-mascots/G1-rim.webp')
    case 'H1':
      return require('../../../src/shared/bot-mascots/H1-rim.webp')
    case 'H2':
      return require('../../../src/shared/bot-mascots/H2-rim.webp')
    case 'I1':
      return require('../../../src/shared/bot-mascots/I1-rim.webp')
    case 'J1':
      return require('../../../src/shared/bot-mascots/J1-rim.webp')
    case 'K2':
      return require('../../../src/shared/bot-mascots/K2-rim.webp')
    case 'L2':
      return require('../../../src/shared/bot-mascots/L2-rim.webp')
    case 'M1':
      return require('../../../src/shared/bot-mascots/M1-rim.webp')
    case 'N1':
      return require('../../../src/shared/bot-mascots/N1-rim.webp')
    case 'O1':
      return require('../../../src/shared/bot-mascots/O1-rim.webp')
    case 'P3':
      return require('../../../src/shared/bot-mascots/P3-rim.webp')
    case 'Q1':
      return require('../../../src/shared/bot-mascots/Q1-rim.webp')
    case 'R3':
      return require('../../../src/shared/bot-mascots/R3-rim.webp')
    case 'S2':
      return require('../../../src/shared/bot-mascots/S2-rim.webp')
    case 'T1':
      return require('../../../src/shared/bot-mascots/T1-rim.webp')
  }
}
