package dev.orca.outsider;

import android.app.Activity;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Bundle;
import android.os.Process;
import android.util.Log;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONObject;

public final class Probe extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        String name = getIntent().getStringExtra("socket");
        new Thread(() -> {
            JSONObject result = new JSONObject();
            try (LocalSocket socket = new LocalSocket()) {
                result.put("uid", Process.myUid()).put("socket", name).put("connected", false);
                socket.connect(new LocalSocketAddress(name, LocalSocketAddress.Namespace.ABSTRACT));
                result.put("connected", true);
                socket.setSoTimeout(3000);
                socket.getOutputStream().write("GET /json/list HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                byte[] data = new byte[4096];
                int count = socket.getInputStream().read(data);
                result.put("bytes", count);
                if (count > 0) result.put("response", new String(data, 0, count, StandardCharsets.UTF_8));
            } catch (Exception error) {
                try { result.put("rejected", error.toString()); } catch (Exception ignored) {}
            } finally {
                try {
                    Files.write(new File(getExternalFilesDir(null), "probe.json").toPath(), result.toString(2).getBytes(StandardCharsets.UTF_8));
                    Log.i("AutomationOutsider", "RESULT " + result);
                } catch (Exception error) { Log.e("AutomationOutsider", "write failed", error); }
                runOnUiThread(this::finish);
            }
        }, "unrelated-uid-probe").start();
    }
}
