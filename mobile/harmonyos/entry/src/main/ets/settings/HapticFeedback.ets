import { vibrator } from '@kit.SensorServiceKit';

export async function playHapticFeedback(kind: string): Promise<void> {
  let effectId = kind === 'success' ? vibrator.HapticFeedback.EFFECT_NOTICE_SUCCESS
    : kind === 'error' ? vibrator.HapticFeedback.EFFECT_NOTICE_FAILURE
    : kind === 'mediumImpact' ? vibrator.HapticFeedback.EFFECT_HARD : vibrator.HapticFeedback.EFFECT_SOFT;
  if (vibrator.isSupportEffectSync(effectId)) {
    await vibrator.startVibration({ type: 'preset', effectId: effectId }, { usage: 'touch' });
  } else {
    await vibrator.startVibration({ type: 'time', duration: kind === 'mediumImpact' ? 30 : kind === 'error' ? 60 : 10 }, { usage: 'touch' });
  }
}
