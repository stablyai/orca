package expo.modules.hardwarekeyboard;

import android.content.Context;
import com.facebook.react.bridge.BridgeReactContext;
import com.facebook.react.uimanager.events.BatchEventDispatchedListener;
import com.facebook.react.uimanager.events.Event;
import com.facebook.react.uimanager.events.EventDispatcher;
import com.facebook.react.uimanager.events.EventDispatcherListener;
import com.facebook.react.uimanager.events.EventDispatcherProvider;
import java.util.ArrayList;
import java.util.List;

// Java can implement RN's JVM-public, Kotlin-internal dispatcher provider without a JS runtime.
public class HardwareKeyboardRecordingContext extends BridgeReactContext implements EventDispatcherProvider {
  public final List<Event<?>> events = new ArrayList<>();
  public boolean dispatcherAvailable = true;
  private final EventDispatcher dispatcher = new EventDispatcher() {
    @Override public void dispatchEvent(Event event) { events.add(event); }
    @Override public void dispatchAllEvents() {}
    @Override public void addListener(EventDispatcherListener listener) {}
    @Override public void removeListener(EventDispatcherListener listener) {}
    @Override public void addBatchEventDispatchedListener(BatchEventDispatchedListener listener) {}
    @Override public void removeBatchEventDispatchedListener(BatchEventDispatchedListener listener) {}
    @Override public void onCatalystInstanceDestroyed() {}
  };

  public HardwareKeyboardRecordingContext(Context context) { super(context); }
  @Override public boolean isBridgeless() { return true; }
  @Override public EventDispatcher getEventDispatcher() { return dispatcherAvailable ? dispatcher : null; }
}
