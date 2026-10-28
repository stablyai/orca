package expo.modules.orcareadaloud

import android.app.StatusBarManager
import android.content.ComponentName
import android.content.Context
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import androidx.annotation.RequiresApi

/**
 * Quick Settings tile that mutes and unmutes auto-read while [ReadAloudService] runs; the mute
 * lives in JS, and the tile redraws when JS reports the new state.
 */
class ReadAloudTileService : TileService() {
  override fun onStartListening() {
    super.onStartListening()
    listening = this
    redraw()
  }

  override fun onStopListening() {
    if (listening === this) listening = null
    super.onStopListening()
  }

  override fun onClick() {
    if (ReadAloudService.isRunning) ReadAloudControls.toggleMute()
  }

  private fun redraw() {
    val tile = qsTile ?: return
    val running = ReadAloudService.isRunning
    val muted = ReadAloudService.isMuted
    tile.state = when {
      !running -> Tile.STATE_UNAVAILABLE
      muted -> Tile.STATE_INACTIVE
      else -> Tile.STATE_ACTIVE
    }
    tile.icon = Icon.createWithResource(
      this,
      if (running && !muted) R.drawable.orca_read_aloud_volume_up else R.drawable.orca_read_aloud_volume_off
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      tile.subtitle = when {
        !running -> "Orca is not reading"
        muted -> "Muted"
        else -> "On"
      }
    }
    tile.updateTile()
  }

  companion object {
    private var listening: ReadAloudTileService? = null

    /** Redraws the tile while Quick Settings shows it, else asks Android to refresh it. */
    fun refresh(context: Context) {
      val shown = listening
      if (shown != null) {
        shown.redraw()
        return
      }
      try {
        TileService.requestListeningState(context, ComponentName(context, ReadAloudTileService::class.java))
      } catch (_: Exception) {
        // Refused while the tile is not in the panel; it redraws whenever it is shown anyway.
      }
    }

    /** Android 13+ "Add tile" prompt; calls back `added`, `already-added`, `not-added` or `error`. */
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    fun requestAdd(context: Context, done: (String) -> Unit) {
      val statusBar = context.getSystemService(StatusBarManager::class.java) ?: return done("error")
      statusBar.requestAddTileService(
        ComponentName(context, ReadAloudTileService::class.java),
        "Read aloud",
        Icon.createWithResource(context, R.drawable.orca_read_aloud_volume_up),
        context.mainExecutor
      ) { result ->
        done(
          when (result) {
            StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ADDED -> "added"
            StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED -> "already-added"
            StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_NOT_ADDED -> "not-added"
            else -> "error"
          }
        )
      }
    }
  }
}
