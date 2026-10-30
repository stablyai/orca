package expo.modules.orcalivealerts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle

/**
 * Builds the live agent notification. A Live Update (Android 16, API 36) must: use a standard,
 * BigText, Call, Progress or Metric style; request promotion; be ongoing; have a content title;
 * have no custom RemoteViews; not be a group summary; not be colorized; and sit on a channel that
 * is not IMPORTANCE_MIN. Older Android gets the same notification without the promotion calls.
 */
internal object LiveAlertNotificationFactory {
  const val CHANNEL_ID = "orca-live-activity"
  const val NOTIFICATION_ID = 7301
  const val EXTRA_TARGET = "expo.modules.orcalivealerts.TARGET"
  private const val REQUEST_OPEN = 7301
  private const val REQUEST_HIDE = 7302
  private const val REQUEST_DELETE = 7303
  private const val FINAL_TIMEOUT_MS = 600_000L
  private const val CHANNEL_NAME = "Live agent activity"
  private const val CHANNEL_DESCRIPTION = "Ongoing status while coding agents run on your desktop"
  // Notification.EXTRA_REQUEST_PROMOTED_ONGOING; the literal avoids depending on SDK stubs.
  private const val EXTRA_REQUEST_PROMOTED_ONGOING = "android.requestPromotedOngoing"
  private val ACCENT_COLOR = 0xFF6366F1.toInt()
  private val PENDING_FLAGS = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

  /** Silent and badge-free. IMPORTANCE_DEFAULT because Live Updates refuse IMPORTANCE_MIN. */
  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < 26) {
      return
    }
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val channel =
      NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT)
    channel.description = CHANNEL_DESCRIPTION
    channel.setSound(null, null)
    channel.enableVibration(false)
    channel.setShowBadge(false)
    manager.createNotificationChannel(channel)
  }

  fun build(context: Context, payload: LiveAlertPayload): Notification {
    val builder = newBuilder(context)
    // setColor is an accent only; setColorized(true) would disqualify the Live Update.
    builder
      .setSmallIcon(smallIcon(context))
      .setContentTitle(payload.title)
      .setContentText(payload.text)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setColor(ACCENT_COLOR)
      .setWhen(payload.startedAt)
      .setShowWhen(true)
      .setContentIntent(openIntent(context, payload.targetJson))
    val subText = payload.subText
    if (subText != null) {
      builder.setSubText(subText)
    }
    applyStyle(builder, payload)
    if (payload.isOngoing) {
      applyOngoing(context, builder, payload)
    } else {
      builder.setAutoCancel(true)
      if (Build.VERSION.SDK_INT >= 26) {
        builder.setTimeoutAfter(FINAL_TIMEOUT_MS)
      }
    }
    return builder.build()
  }

  private fun newBuilder(context: Context): Notification.Builder =
    if (Build.VERSION.SDK_INT >= 26) {
      Notification.Builder(context, CHANNEL_ID)
    } else {
      legacyBuilder(context)
    }

  @Suppress("DEPRECATION")
  private fun legacyBuilder(context: Context): Notification.Builder =
    Notification.Builder(context).setPriority(Notification.PRIORITY_DEFAULT)

  // API 36+: a ProgressStyle bar (one segment per session agent) once a session has 2+ agents,
  // else BigText. Older Android: BigText plus the classic progress bar.
  private fun applyStyle(builder: Notification.Builder, payload: LiveAlertPayload) {
    val total = payload.progressTotal
    val finished = payload.progressFinished ?: 0
    if (Build.VERSION.SDK_INT >= 36 && total != null && total >= 2) {
      val segment = Notification.ProgressStyle.Segment(total).setColor(ACCENT_COLOR)
      val style =
        Notification.ProgressStyle()
          .setProgressSegments(listOf(segment))
          .setProgress(finished.coerceIn(0, total))
      builder.setStyle(style)
      return
    }
    builder.setStyle(Notification.BigTextStyle().bigText(payload.text))
    if (Build.VERSION.SDK_INT < 36) {
      if (total != null && total >= 2) {
        builder.setProgress(total, finished.coerceIn(0, total), false)
      } else if (payload.indeterminate) {
        builder.setProgress(0, 0, true)
      }
    }
  }

  private fun applyOngoing(
    context: Context,
    builder: Notification.Builder,
    payload: LiveAlertPayload
  ) {
    // A swipe (Android 14+ lets users dismiss ongoing notifications) or Hide ends the session.
    builder
      .setOngoing(true)
      .setDeleteIntent(serviceIntent(context, LiveAgentService.ACTION_DISMISSED, REQUEST_DELETE))
      .addAction(hideAction(context))
    if (!payload.isLingering) {
      builder.setUsesChronometer(true)
    }
    if (Build.VERSION.SDK_INT >= 31) {
      builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    }
    if (Build.VERSION.SDK_INT >= 36) {
      // Request promotion. The android-36 SDK has no Notification.Builder.setRequestPromotedOngoing;
      // the extra is what that setter (and NotificationCompat's) writes and what the system reads.
      builder.addExtras(Bundle().apply { putBoolean(EXTRA_REQUEST_PROMOTED_ONGOING, true) })
      // The status-bar chip; payloads keep it to 7 characters or fewer so it shows whole.
      val chip = payload.chipText
      if (chip != null) {
        builder.setShortCriticalText(chip)
      }
    }
  }

  private fun hideAction(context: Context): Notification.Action =
    Notification.Action.Builder(
      Icon.createWithResource(context, smallIcon(context)),
      "Hide",
      serviceIntent(context, LiveAgentService.ACTION_HIDE, REQUEST_HIDE)
    ).build()

  private fun serviceIntent(context: Context, action: String, requestCode: Int): PendingIntent {
    val intent = Intent(context, LiveAgentService::class.java).setAction(action)
    return PendingIntent.getService(context, requestCode, intent, PENDING_FLAGS)
  }

  // The launch intent plus the tap target as an extra: the module hands it to JavaScript through
  // OnNewIntent (warm) or consumeLaunchTarget (cold). A URL would hit expo-router's unmatched route.
  private fun openIntent(context: Context, targetJson: String?): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (targetJson != null) {
      launch.putExtra(EXTRA_TARGET, targetJson)
    }
    return PendingIntent.getActivity(context, REQUEST_OPEN, launch, PENDING_FLAGS)
  }

  // expo-notifications generates drawable/notification_icon from app.config.js; fall back to the
  // app icon so a build without it still posts.
  private fun smallIcon(context: Context): Int {
    val id = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (id != 0) id else context.applicationInfo.icon
  }
}
