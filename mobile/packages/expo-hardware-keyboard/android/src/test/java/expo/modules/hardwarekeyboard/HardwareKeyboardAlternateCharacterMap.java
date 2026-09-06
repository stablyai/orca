package expo.modules.hardwarekeyboard;

import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowKeyCharacterMap;

@Implements(KeyCharacterMap.class)
public class HardwareKeyboardAlternateCharacterMap extends ShadowKeyCharacterMap {
  @Implementation
  protected static char nativeGetCharacter(long pointer, int keyCode, int metaState) {
    if (keyCode != KeyEvent.KEYCODE_Q) return '\u0000';
    boolean shifted = (metaState & KeyEvent.META_SHIFT_ON) != 0;
    if ((metaState & KeyEvent.META_ALT_ON) != 0) return shifted ? '#' : '@';
    return shifted ? 'Q' : 'q';
  }

  @Implementation
  protected static char nativeGetDisplayLabel(long pointer, int keyCode) {
    return keyCode == KeyEvent.KEYCODE_Q ? 'Q' : '\u0000';
  }
}
