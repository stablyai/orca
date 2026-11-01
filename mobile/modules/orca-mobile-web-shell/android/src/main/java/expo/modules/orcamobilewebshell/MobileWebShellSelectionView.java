package expo.modules.orcamobilewebshell;

import android.content.Context;
import android.graphics.Rect;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.WebView;

final class MobileWebShellSelectionView extends WebView {
  private int activeSelections;
  private int previousLayerType;

  MobileWebShellSelectionView(Context context) {
    super(context);
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
        if (activeSelections++ == 0) {
          previousLayerType = getLayerType();
          // Keep magnifier readback on a dedicated GPU texture while selection is active.
          setLayerType(View.LAYER_TYPE_HARDWARE, null);
        }
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
        if (--activeSelections == 0) setLayerType(previousLayerType, null);
      }
    }, type);
  }
}
