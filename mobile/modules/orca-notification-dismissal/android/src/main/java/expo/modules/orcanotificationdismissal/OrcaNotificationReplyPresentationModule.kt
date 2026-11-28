package expo.modules.orcanotificationdismissal

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OrcaNotificationReplyPresentationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OrcaNotificationReplyPresentation")

    AsyncFunction("showReplySent") { identifier: String, text: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return@AsyncFunction
      val context = appContext.reactContext ?: return@AsyncFunction
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val original = manager.activeNotifications.firstOrNull { it.tag == identifier }
        ?: return@AsyncFunction
      // Update the original channel/icon in place without triggering another alert or JS delivery.
      val updated = Notification.Builder.recoverBuilder(context, original.notification)
        .setContentText(text)
        .setStyle(Notification.BigTextStyle().bigText(text))
        .setActions()
        .setOnlyAlertOnce(true)
        .build()
      manager.notify(original.tag, original.id, updated)
    }
  }
}
