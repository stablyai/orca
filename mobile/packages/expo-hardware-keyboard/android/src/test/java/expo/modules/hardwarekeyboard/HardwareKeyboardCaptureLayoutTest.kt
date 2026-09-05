package expo.modules.hardwarekeyboard

import android.graphics.Rect
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import expo.modules.kotlin.AppContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class HardwareKeyboardCaptureLayoutTest {
  private val context get() = RuntimeEnvironment.getApplication()

  private fun exact(size: Int) = View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY)
  private fun bounds(view: View) = Rect(view.left, view.top, view.right, view.bottom)

  private fun addYogaChildren(parent: LinearLayout): EditText {
    val affordance = View(context)
    parent.addView(affordance, LinearLayout.LayoutParams(1080, 106))
    val input = EditText(context)
    parent.addView(input, LinearLayout.LayoutParams(1, 1))
    parent.measure(exact(1080), exact(106))
    affordance.layout(0, 0, 1080, 106)
    input.measure(exact(1), exact(1))
    input.layout(0, 0, 1, 1)
    return input
  }

  @Test fun capturePreservesYogaInputBoundsAcrossParentLayoutAndResize() {
    // Layout never reads Expo runtime state; avoid initializing JSI in this native layout test.
    val unsafeClass = Class.forName("sun.misc.Unsafe")
    val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
    val appContext = unsafeClass.getMethod("allocateInstance", Class::class.java)
      .invoke(unsafe, AppContext::class.java) as AppContext
    val capture = HardwareKeyboardCaptureView(context, appContext)
    val input = addYogaChildren(capture)
    capture.layout(0, 0, 1080, 106)
    assertEquals(Rect(0, 0, 1, 1), bounds(input))
    capture.measure(exact(720), exact(106))
    capture.layout(0, 0, 720, 106)
    assertEquals(Rect(0, 0, 1, 1), bounds(input))
    assertEquals(720, capture.measuredWidth)
    assertEquals(106, capture.measuredHeight)
  }

  @Test fun inheritedLinearLayoutWouldMoveTheCaptureInputBeyondItsParent() {
    val inheritedLayout = LinearLayout(context)
    val input = addYogaChildren(inheritedLayout)
    inheritedLayout.layout(0, 0, 1080, 106)
    assertNotEquals(Rect(0, 0, 1, 1), bounds(input))
    assertEquals(1080, input.left)
  }
}
