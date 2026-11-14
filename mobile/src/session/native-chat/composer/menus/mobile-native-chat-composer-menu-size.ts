import { MESSAGE_MIN_HEIGHT } from '../../../../components/composer-input/composer-input-styles'

export const COMPOSER_MENU_MAX_HEIGHT = 300

export type ComposerMenuIntrinsicSize = {
  content: number
  chrome: number
  firstGroup: number
}

export function composerMenuReservation(
  intrinsic: ComposerMenuIntrinsicSize | null,
  viewport: number,
  composerChrome: number
): number {
  if (!intrinsic) {
    return 0
  }
  const requested = Math.min(intrinsic.content, COMPOSER_MENU_MAX_HEIGHT) + intrinsic.chrome
  const available = viewport - composerChrome - MESSAGE_MIN_HEIGHT
  const firstGroup = Math.min(requested, intrinsic.firstGroup + intrinsic.chrome)
  // When one result cannot fit beside the field, scroll the whole interaction instead.
  return available >= firstGroup ? Math.min(requested, available) : requested
}

export function composerFieldAllowance(
  viewport: number,
  composerChrome: number,
  reservation: number
): number {
  return Math.max(MESSAGE_MIN_HEIGHT, Math.floor(viewport - composerChrome - reservation))
}
