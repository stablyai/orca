package expo.modules.orcamobilewebshell;

import android.content.Context;
import android.graphics.Rect;
import android.text.InputType;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.WebView;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;

final class MobileWebShellSelectionView extends WebView {
  private int activeSelections;
  private int previousLayerType;
  private boolean editing;
  private boolean protectedLayer;

  MobileWebShellSelectionView(Context context) {
    super(context);
  }

  @Override
  public InputConnection onCreateInputConnection(EditorInfo info) {
    InputConnection connection = super.onCreateInputConnection(info);
    editing = hasFocus() && connection != null && info.inputType != InputType.TYPE_NULL;
    updateLayer();
    return connection;
  }

  @Override
  protected void onFocusChanged(boolean focused, int direction, Rect previous) {
    super.onFocusChanged(focused, direction, previous);
    if (!focused) {
      editing = false;
      updateLayer();
    }
  }

  private void updateLayer() {
    boolean protect = editing || activeSelections > 0;
    if (protect == protectedLayer) return;
    if (protect) {
      previousLayerType = getLayerType();
      // Both insertion and selection magnifiers need a dedicated GPU readback texture.
      setLayerType(View.LAYER_TYPE_HARDWARE, null);
    } else {
      setLayerType(previousLayerType, null);
    }
    protectedLayer = protect;
  }

  @Override
  public ActionMode startActionMode(ActionMode.Callback callback) {
    return startActionMode(callback, ActionMode.TYPE_PRIMARY);
  }

  @Override
  public ActionMode startActionMode(ActionMode.Callback callback, int type) {
    return super.startActionMode(new ActionMode.Callback2() {
      private boolean holdsLayer;

      @Override
      public boolean onCreateActionMode(ActionMode mode, Menu menu) {
        activeSelections++;
        updateLayer();
        holdsLayer = true;
        boolean accepted = false;
        try {
          accepted = callback.onCreateActionMode(mode, menu);
          return accepted;
        } finally {
          if (!accepted) releaseLayer();
        }
      }

      @Override
      public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
        return callback.onPrepareActionMode(mode, menu);
      }

      @Override
      public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
        return callback.onActionItemClicked(mode, item);
      }

      @Override
      public void onGetContentRect(ActionMode mode, View view, Rect rect) {
        if (callback instanceof ActionMode.Callback2) {
          // SAFETY: the content-rectangle callback is guarded by its runtime type.
          ((ActionMode.Callback2) callback).onGetContentRect(mode, view, rect);
        } else {
          super.onGetContentRect(mode, view, rect);
        }
      }

      @Override
      public void onDestroyActionMode(ActionMode mode) {
        try {
          callback.onDestroyActionMode(mode);
        } finally {
          releaseLayer();
        }
      }

      private void releaseLayer() {
        if (!holdsLayer) return;
        holdsLayer = false;
        activeSelections--;
        updateLayer();
      }
    }, type);
  }
}
